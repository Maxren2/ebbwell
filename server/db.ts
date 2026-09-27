import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DayDataSchema, SettingsSchema, defaultSettings, type DayData, type DayEntry, type Settings } from '../shared/schema.ts';
import type { Cipher } from './crypto.ts';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    oidc_sub      TEXT NOT NULL UNIQUE,
    profile_enc   TEXT NOT NULL,
    settings_enc  TEXT,
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE sessions (
    id             TEXT PRIMARY KEY,           -- sha256 of the cookie token
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at     INTEGER NOT NULL,
    last_seen_at   INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL,
    user_agent_enc TEXT NOT NULL
  ) STRICT;
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE days (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date       TEXT NOT NULL,
    data_enc   TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, date)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE audit (
    id      INTEGER PRIMARY KEY,
    user_id TEXT,
    at      INTEGER NOT NULL,
    event   TEXT NOT NULL
  ) STRICT;
  `,
];

export interface User {
  id: string;
  name: string;
}

export interface SessionRow {
  id: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  userAgent: string;
}

const aad = {
  profile: (userId: string) => `profile:${userId}`,
  settings: (userId: string) => `settings:${userId}`,
  day: (userId: string, date: string) => `day:${userId}:${date}`,
  ua: (sessionId: string) => `ua:${sessionId}`,
};

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;
  private readonly cipher: Cipher;

  constructor(path: string, cipher: Cipher) {
    this.path = path;
    this.cipher = cipher;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA secure_delete = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.migrate();
  }

  private migrate() {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close() {
    this.db.close();
  }

  // ------------------------------------------------------------ users

  upsertUser(sub: string, name: string): User {
    const now = Date.now();
    const existing = this.db.prepare('SELECT id FROM users WHERE oidc_sub = ?').get(sub) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    const profile = this.cipher.encryptJson({ name }, aad.profile(id));
    if (existing) {
      this.db.prepare('UPDATE users SET profile_enc = ?, last_login_at = ? WHERE id = ?').run(profile, now, id);
    } else {
      this.db
        .prepare('INSERT INTO users (id, oidc_sub, profile_enc, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, sub, profile, now, now);
    }
    return { id, name };
  }

  getUser(id: string): User | null {
    const row = this.db.prepare('SELECT id, profile_enc FROM users WHERE id = ?').get(id) as
      | { id: string; profile_enc: string }
      | undefined;
    if (!row) return null;
    const { name } = this.cipher.decryptJson<{ name: string }>(row.profile_enc, aad.profile(id));
    return { id, name };
  }

  deleteUser(id: string) {
    this.tx(() => {
      this.db.prepare('DELETE FROM days WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM audit WHERE user_id = ?').run(id);
    });
  }

  getSettings(userId: string): Settings {
    const row = this.db.prepare('SELECT settings_enc FROM users WHERE id = ?').get(userId) as
      | { settings_enc: string | null }
      | undefined;
    if (!row?.settings_enc) return defaultSettings();
    const raw = this.cipher.decryptJson<unknown>(row.settings_enc, aad.settings(userId));
    const parsed = SettingsSchema.safeParse(raw);
    return parsed.success ? parsed.data : defaultSettings();
  }

  saveSettings(userId: string, settings: Settings) {
    this.db
      .prepare('UPDATE users SET settings_enc = ? WHERE id = ?')
      .run(this.cipher.encryptJson(settings, aad.settings(userId)), userId);
  }

  // ------------------------------------------------------------ days

  listDays(userId: string): DayEntry[] {
    const rows = this.db.prepare('SELECT date, data_enc FROM days WHERE user_id = ? ORDER BY date').all(userId) as {
      date: string;
      data_enc: string;
    }[];
    return rows.map((r) => ({ date: r.date, data: this.cipher.decryptJson<DayData>(r.data_enc, aad.day(userId, r.date)) }));
  }

  putDay(userId: string, date: string, data: DayData) {
    const enc = this.cipher.encryptJson(DayDataSchema.parse(data), aad.day(userId, date));
    this.db
      .prepare(
        `INSERT INTO days (user_id, date, data_enc, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, date) DO UPDATE SET data_enc = excluded.data_enc, updated_at = excluded.updated_at`,
      )
      .run(userId, date, enc, Date.now());
  }

  deleteDay(userId: string, date: string) {
    this.db.prepare('DELETE FROM days WHERE user_id = ? AND date = ?').run(userId, date);
  }

  deleteAllDays(userId: string) {
    this.db.prepare('DELETE FROM days WHERE user_id = ?').run(userId);
  }

  // ------------------------------------------------------------ sessions

  createSession(id: string, userId: string, userAgent: string, expiresAt: number) {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent_enc) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, userId, now, now, expiresAt, this.cipher.encrypt(userAgent.slice(0, 300), aad.ua(id)));
  }

  getSession(id: string): SessionRow | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, string | number> | undefined;
    return row ? this.toSession(row) : null;
  }

  listSessions(userId: string): SessionRow[] {
    const rows = this.db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC').all(userId) as Record<
      string,
      string | number
    >[];
    return rows.map((r) => this.toSession(r));
  }

  private toSession(row: Record<string, string | number>): SessionRow {
    const id = row.id as string;
    let userAgent = '';
    try {
      userAgent = this.cipher.decrypt(row.user_agent_enc as string, aad.ua(id));
    } catch {
      /* unreadable UA is not fatal */
    }
    return {
      id,
      userId: row.user_id as string,
      createdAt: row.created_at as number,
      lastSeenAt: row.last_seen_at as number,
      expiresAt: row.expires_at as number,
      userAgent,
    };
  }

  touchSession(id: string, at: number) {
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(at, id);
  }

  deleteSession(id: string, userId?: string) {
    if (userId) this.db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(id, userId);
    else this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  deleteOtherSessions(userId: string, keepId: string) {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, keepId);
  }

  purgeExpiredSessions(idleCutoff: number) {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?').run(Date.now(), idleCutoff);
  }

  // ------------------------------------------------------------ audit

  audit(userId: string | null, event: string) {
    this.db.prepare('INSERT INTO audit (user_id, at, event) VALUES (?, ?, ?)').run(userId, Date.now(), event);
  }

  listAudit(userId: string, limit = 50): { at: number; event: string }[] {
    return this.db.prepare('SELECT at, event FROM audit WHERE user_id = ? ORDER BY at DESC LIMIT ?').all(userId, limit) as {
      at: number;
      event: string;
    }[];
  }

  // ------------------------------------------------------------ maintenance

  /** Re-encrypts everything written with DATA_ENCRYPTION_KEY_PREVIOUS. Returns rows updated. */
  rotateKeys(): number {
    let n = 0;
    this.tx(() => {
      const users = this.db.prepare('SELECT id, profile_enc, settings_enc FROM users').all() as {
        id: string;
        profile_enc: string;
        settings_enc: string | null;
      }[];
      for (const u of users) {
        if (this.cipher.isStale(u.profile_enc)) {
          const p = this.cipher.decrypt(u.profile_enc, aad.profile(u.id));
          this.db.prepare('UPDATE users SET profile_enc = ? WHERE id = ?').run(this.cipher.encrypt(p, aad.profile(u.id)), u.id);
          n++;
        }
        if (u.settings_enc && this.cipher.isStale(u.settings_enc)) {
          const s = this.cipher.decrypt(u.settings_enc, aad.settings(u.id));
          this.db.prepare('UPDATE users SET settings_enc = ? WHERE id = ?').run(this.cipher.encrypt(s, aad.settings(u.id)), u.id);
          n++;
        }
      }
      const days = this.db.prepare('SELECT user_id, date, data_enc FROM days').all() as {
        user_id: string;
        date: string;
        data_enc: string;
      }[];
      for (const d of days) {
        if (!this.cipher.isStale(d.data_enc)) continue;
        const a = aad.day(d.user_id, d.date);
        this.db
          .prepare('UPDATE days SET data_enc = ? WHERE user_id = ? AND date = ?')
          .run(this.cipher.encrypt(this.cipher.decrypt(d.data_enc, a), a), d.user_id, d.date);
        n++;
      }
      const sessions = this.db.prepare('SELECT id, user_agent_enc FROM sessions').all() as { id: string; user_agent_enc: string }[];
      for (const s of sessions) {
        if (!this.cipher.isStale(s.user_agent_enc)) continue;
        const ua = this.cipher.decrypt(s.user_agent_enc, aad.ua(s.id));
        this.db.prepare('UPDATE sessions SET user_agent_enc = ? WHERE id = ?').run(this.cipher.encrypt(ua, aad.ua(s.id)), s.id);
        n++;
      }
    });
    return n;
  }

  /** Consistent online backup (encrypted content stays encrypted), pruning old ones. */
  backup(dir: string, retentionDays: number): string | null {
    if (retentionDays <= 0) return null;
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
    const file = join(dir, `lune-${stamp}.sqlite`);
    rmSync(file, { force: true });
    this.db.prepare('VACUUM INTO ?').run(file);
    const cutoff = Date.now() - retentionDays * 86_400_000;
    for (const f of readdirSync(dir)) {
      if (!/^lune-.*\.sqlite$/.test(f)) continue;
      const p = join(dir, f);
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
    }
    return file;
  }

  lastBackupAge(dir: string): number {
    try {
      const times = readdirSync(dir)
        .filter((f) => /^lune-.*\.sqlite$/.test(f))
        .map((f) => statSync(join(dir, f)).mtimeMs);
      return times.length ? Date.now() - Math.max(...times) : Infinity;
    } catch {
      return Infinity;
    }
  }
}
