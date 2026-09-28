import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DayDataSchema, SettingsSchema, defaultSettings, type DayData, type DayEntry, type Settings } from '../shared/schema.ts';
import { SHARE_SCOPES, type ShareScope } from '../shared/partner.ts';
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
  `
  -- App lock: per-session unlock window; PIN per user; biometric (WebAuthn) credentials per device.
  ALTER TABLE sessions ADD COLUMN unlocked_until INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN failed_unlocks INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN reset_until INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE meta (
    key       TEXT PRIMARY KEY,
    value_enc TEXT NOT NULL
  ) STRICT;

  CREATE TABLE app_locks (
    user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    pin_hash    TEXT NOT NULL,
    timeout_sec INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE webauthn_credentials (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key   TEXT NOT NULL,
    counter      INTEGER NOT NULL,
    transports   TEXT NOT NULL,
    name_enc     TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
  ) STRICT;
  CREATE INDEX webauthn_user ON webauthn_credentials(user_id);

  CREATE TABLE push_subscriptions (
    id              TEXT PRIMARY KEY,          -- sha256 of the endpoint
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    data_enc        TEXT NOT NULL,
    user_agent_enc  TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    last_success_at INTEGER
  ) STRICT;
  CREATE INDEX push_user ON push_subscriptions(user_id);

  CREATE TABLE notification_log (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind    TEXT NOT NULL,
    key     TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind, key)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE shares (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    partner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scopes     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (owner_id, partner_id)
  ) STRICT;

  CREATE TABLE share_invites (
    id         TEXT PRIMARY KEY,               -- sha256 of the invite code
    owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scopes     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
  `,
  `
  -- Local accounts and administration. Local users get oidc_sub = 'local|<id>'.
  ALTER TABLE users ADD COLUMN username TEXT;
  ALTER TABLE users ADD COLUMN password_hash TEXT;
  ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN locked_until INTEGER NOT NULL DEFAULT 0;
  CREATE UNIQUE INDEX users_username ON users(username) WHERE username IS NOT NULL;
  `,
];

export type AccountKind = 'oidc' | 'local' | 'dev';

export interface User {
  id: string;
  name: string;
  kind: AccountKind;
  username: string | null;
  isAdmin: boolean;
  disabled: boolean;
  mustChangePassword: boolean;
}

export interface UserSummary extends User {
  createdAt: number;
  lastLoginAt: number;
  lockedUntil: number;
}

export interface LocalCredentials {
  user: User;
  passwordHash: string;
  failedLogins: number;
  lockedUntil: number;
}

export interface SessionRow {
  id: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  userAgent: string;
  unlockedUntil: number;
  failedUnlocks: number;
  resetUntil: number;
}

export interface AppLock {
  pinHash: string;
  timeoutSec: number;
}

export interface WebAuthnCredential {
  id: string;
  userId: string;
  publicKey: string; // base64url
  counter: number;
  transports: string[];
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface PushSubscriptionRow {
  id: string;
  userId: string;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  userAgent: string;
  createdAt: number;
}

export interface Share {
  id: string;
  ownerId: string;
  partnerId: string;
  scopes: ShareScope[];
  createdAt: number;
}

export interface ShareInvite {
  id: string;
  ownerId: string;
  scopes: ShareScope[];
  createdAt: number;
  expiresAt: number;
}

type Row = Record<string, string | number | null>;

const aad = {
  profile: (userId: string) => `profile:${userId}`,
  settings: (userId: string) => `settings:${userId}`,
  day: (userId: string, date: string) => `day:${userId}:${date}`,
  ua: (sessionId: string) => `ua:${sessionId}`,
  meta: (key: string) => `meta:${key}`,
  webauthn: (id: string) => `webauthn:${id}`,
  push: (id: string) => `push:${id}`,
  pushUa: (id: string) => `push-ua:${id}`,
};

/** Every encrypted column, for key rotation. */
const ENCRYPTED_COLUMNS: { table: string; column: string; keys: string[]; aad: (r: Row) => string }[] = [
  { table: 'users', column: 'profile_enc', keys: ['id'], aad: (r) => aad.profile(r.id as string) },
  { table: 'users', column: 'settings_enc', keys: ['id'], aad: (r) => aad.settings(r.id as string) },
  { table: 'days', column: 'data_enc', keys: ['user_id', 'date'], aad: (r) => aad.day(r.user_id as string, r.date as string) },
  { table: 'sessions', column: 'user_agent_enc', keys: ['id'], aad: (r) => aad.ua(r.id as string) },
  { table: 'meta', column: 'value_enc', keys: ['key'], aad: (r) => aad.meta(r.key as string) },
  { table: 'webauthn_credentials', column: 'name_enc', keys: ['id'], aad: (r) => aad.webauthn(r.id as string) },
  { table: 'push_subscriptions', column: 'data_enc', keys: ['id'], aad: (r) => aad.push(r.id as string) },
  { table: 'push_subscriptions', column: 'user_agent_enc', keys: ['id'], aad: (r) => aad.pushUa(r.id as string) },
];

const parseScopes = (raw: string): ShareScope[] => {
  const list = JSON.parse(raw) as unknown[];
  return SHARE_SCOPES.filter((s) => list.includes(s));
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

  // ------------------------------------------------------------ meta (encrypted key/value)

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value_enc FROM meta WHERE key = ?').get(key) as { value_enc: string } | undefined;
    return row ? this.cipher.decrypt(row.value_enc, aad.meta(key)) : null;
  }

  setMeta(key: string, value: string) {
    this.db
      .prepare('INSERT INTO meta (key, value_enc) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value_enc = excluded.value_enc')
      .run(key, this.cipher.encrypt(value, aad.meta(key)));
  }

  // ------------------------------------------------------------ users

  private toUser(row: Row): User {
    const id = row.id as string;
    const { name } = this.cipher.decryptJson<{ name: string }>(row.profile_enc as string, aad.profile(id));
    const sub = row.oidc_sub as string;
    return {
      id,
      name,
      kind: sub.startsWith('local|') ? 'local' : sub === 'dev-user' ? 'dev' : 'oidc',
      username: (row.username as string | null) ?? null,
      isAdmin: row.is_admin === 1,
      disabled: row.disabled === 1,
      mustChangePassword: row.must_change_password === 1,
    };
  }

  /** Creates or refreshes an identity-provider (or dev) user. `isAdmin` syncs the admin flag when given. */
  upsertUser(sub: string, name: string, opts: { isAdmin?: boolean } = {}): User {
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
    if (opts.isAdmin !== undefined) this.setAdmin(id, opts.isAdmin);
    return this.getUser(id)!;
  }

  getUser(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    return row ? this.toUser(row) : null;
  }

  createLocalUser(opts: { username: string; name: string; passwordHash: string; isAdmin: boolean; mustChangePassword: boolean }): User {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO users (id, oidc_sub, profile_enc, created_at, last_login_at, username, password_hash, is_admin, must_change_password)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(id, `local|${id}`, this.cipher.encryptJson({ name: opts.name }, aad.profile(id)), now, opts.username, opts.passwordHash, opts.isAdmin ? 1 : 0, opts.mustChangePassword ? 1 : 0);
    return this.getUser(id)!;
  }

  findLocalCredentials(username: string): LocalCredentials | null {
    const row = this.db.prepare("SELECT * FROM users WHERE username = ? AND oidc_sub LIKE 'local|%'").get(username) as Row | undefined;
    if (!row || !row.password_hash) return null;
    return {
      user: this.toUser(row),
      passwordHash: row.password_hash as string,
      failedLogins: row.failed_logins as number,
      lockedUntil: row.locked_until as number,
    };
  }

  getPasswordHash(id: string): string | null {
    const row = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id) as { password_hash: string | null } | undefined;
    return row?.password_hash ?? null;
  }

  setPassword(id: string, passwordHash: string, mustChange: boolean) {
    this.db
      .prepare('UPDATE users SET password_hash = ?, must_change_password = ?, failed_logins = 0, locked_until = 0 WHERE id = ?')
      .run(passwordHash, mustChange ? 1 : 0, id);
  }

  /** Counts a failed password; locks the account for `lockMs` after `maxFailures`. Returns locked_until. */
  recordLoginFailure(id: string, maxFailures: number, lockMs: number): number {
    const row = this.db.prepare('SELECT failed_logins FROM users WHERE id = ?').get(id) as { failed_logins: number };
    const failures = row.failed_logins + 1;
    const lockedUntil = failures >= maxFailures ? Date.now() + lockMs : 0;
    this.db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(lockedUntil ? 0 : failures, lockedUntil, id);
    return lockedUntil;
  }

  recordLogin(id: string) {
    this.db.prepare('UPDATE users SET failed_logins = 0, locked_until = 0, last_login_at = ? WHERE id = ?').run(Date.now(), id);
  }

  setAdmin(id: string, isAdmin: boolean) {
    this.db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
  }

  setDisabled(id: string, disabled: boolean) {
    this.tx(() => {
      this.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
      if (disabled) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    });
  }

  listUsers(): UserSummary[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY created_at').all() as Row[];
    return rows.map((r) => ({
      ...this.toUser(r),
      createdAt: r.created_at as number,
      lastLoginAt: r.last_login_at as number,
      lockedUntil: r.locked_until as number,
    }));
  }

  countActiveAdmins(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0').get() as { n: number }).n;
  }

  deleteUserSessions(id: string, exceptSessionId = '') {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(id, exceptSessionId);
  }

  deleteUser(id: string) {
    this.tx(() => {
      // Child rows go through ON DELETE CASCADE; audit rows have no foreign key.
      this.db.prepare('DELETE FROM audit WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
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

  getDay(userId: string, date: string): DayData | null {
    const row = this.db.prepare('SELECT data_enc FROM days WHERE user_id = ? AND date = ?').get(userId, date) as
      | { data_enc: string }
      | undefined;
    return row ? this.cipher.decryptJson<DayData>(row.data_enc, aad.day(userId, date)) : null;
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

  createSession(id: string, userId: string, userAgent: string, expiresAt: number, lock: { unlockedUntil: number; resetUntil: number }) {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent_enc, unlocked_until, reset_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, userId, now, now, expiresAt, this.cipher.encrypt(userAgent.slice(0, 300), aad.ua(id)), lock.unlockedUntil, lock.resetUntil);
  }

  getSession(id: string): SessionRow | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return row ? this.toSession(row) : null;
  }

  listSessions(userId: string): SessionRow[] {
    const rows = this.db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC').all(userId) as Row[];
    return rows.map((r) => this.toSession(r));
  }

  private toSession(row: Row): SessionRow {
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
      unlockedUntil: row.unlocked_until as number,
      failedUnlocks: row.failed_unlocks as number,
      resetUntil: row.reset_until as number,
    };
  }

  touchSession(id: string, at: number) {
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(at, id);
  }

  setUnlocked(id: string, until: number) {
    this.db.prepare('UPDATE sessions SET unlocked_until = ?, failed_unlocks = 0 WHERE id = ?').run(until, id);
  }

  /** Locks every session of the user (e.g. after the PIN changed). */
  lockAllSessions(userId: string, exceptId?: string) {
    this.db.prepare('UPDATE sessions SET unlocked_until = 0 WHERE user_id = ? AND id <> ?').run(userId, exceptId ?? '');
  }

  recordFailedUnlock(id: string): number {
    this.db.prepare('UPDATE sessions SET failed_unlocks = failed_unlocks + 1 WHERE id = ?').run(id);
    return (this.db.prepare('SELECT failed_unlocks FROM sessions WHERE id = ?').get(id) as { failed_unlocks: number } | undefined)
      ?.failed_unlocks ?? 0;
  }

  clearReset(id: string) {
    this.db.prepare('UPDATE sessions SET reset_until = 0 WHERE id = ?').run(id);
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
    this.db.prepare('DELETE FROM share_invites WHERE expires_at < ?').run(Date.now());
  }

  // ------------------------------------------------------------ app lock

  getLock(userId: string): AppLock | null {
    const row = this.db.prepare('SELECT pin_hash, timeout_sec FROM app_locks WHERE user_id = ?').get(userId) as
      | { pin_hash: string; timeout_sec: number }
      | undefined;
    return row ? { pinHash: row.pin_hash, timeoutSec: row.timeout_sec } : null;
  }

  setLock(userId: string, pinHash: string, timeoutSec: number) {
    this.db
      .prepare(
        `INSERT INTO app_locks (user_id, pin_hash, timeout_sec, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET pin_hash = excluded.pin_hash, timeout_sec = excluded.timeout_sec, updated_at = excluded.updated_at`,
      )
      .run(userId, pinHash, timeoutSec, Date.now());
  }

  setLockTimeout(userId: string, timeoutSec: number) {
    this.db.prepare('UPDATE app_locks SET timeout_sec = ?, updated_at = ? WHERE user_id = ?').run(timeoutSec, Date.now(), userId);
  }

  removeLock(userId: string) {
    this.tx(() => {
      this.db.prepare('DELETE FROM app_locks WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM webauthn_credentials WHERE user_id = ?').run(userId);
    });
  }

  listCredentials(userId: string): WebAuthnCredential[] {
    const rows = this.db.prepare('SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at').all(userId) as Row[];
    return rows.map((r) => ({
      id: r.id as string,
      userId: r.user_id as string,
      publicKey: r.public_key as string,
      counter: r.counter as number,
      transports: JSON.parse(r.transports as string) as string[],
      name: this.cipher.decrypt(r.name_enc as string, aad.webauthn(r.id as string)),
      createdAt: r.created_at as number,
      lastUsedAt: r.last_used_at as number | null,
    }));
  }

  addCredential(c: Omit<WebAuthnCredential, 'createdAt' | 'lastUsedAt'>) {
    this.db
      .prepare(
        'INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports, name_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(c.id, c.userId, c.publicKey, c.counter, JSON.stringify(c.transports), this.cipher.encrypt(c.name.slice(0, 60), aad.webauthn(c.id)), Date.now());
  }

  updateCredentialCounter(id: string, counter: number) {
    this.db.prepare('UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?').run(counter, Date.now(), id);
  }

  deleteCredential(userId: string, id: string) {
    this.db.prepare('DELETE FROM webauthn_credentials WHERE user_id = ? AND id = ?').run(userId, id);
  }

  // ------------------------------------------------------------ push

  savePushSubscription(id: string, userId: string, subscription: PushSubscriptionRow['subscription'], userAgent: string) {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (id, user_id, data_enc, user_agent_enc, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET user_id = excluded.user_id, data_enc = excluded.data_enc, user_agent_enc = excluded.user_agent_enc`,
      )
      .run(id, userId, this.cipher.encryptJson(subscription, aad.push(id)), this.cipher.encrypt(userAgent.slice(0, 300), aad.pushUa(id)), Date.now());
  }

  listPushSubscriptions(userId: string): PushSubscriptionRow[] {
    const rows = this.db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at').all(userId) as Row[];
    return rows.map((r) => ({
      id: r.id as string,
      userId: r.user_id as string,
      subscription: this.cipher.decryptJson(r.data_enc as string, aad.push(r.id as string)),
      userAgent: this.cipher.decrypt(r.user_agent_enc as string, aad.pushUa(r.id as string)),
      createdAt: r.created_at as number,
    }));
  }

  usersWithPushSubscriptions(): string[] {
    return (this.db.prepare('SELECT DISTINCT user_id FROM push_subscriptions').all() as { user_id: string }[]).map((r) => r.user_id);
  }

  deletePushSubscription(id: string, userId?: string) {
    if (userId) this.db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(id, userId);
    else this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id);
  }

  markPushSuccess(id: string) {
    this.db.prepare('UPDATE push_subscriptions SET last_success_at = ? WHERE id = ?').run(Date.now(), id);
  }

  /** Records a notification; returns false if it was already sent (idempotent). */
  claimNotification(userId: string, kind: string, key: string): boolean {
    const res = this.db
      .prepare('INSERT OR IGNORE INTO notification_log (user_id, kind, key, sent_at) VALUES (?, ?, ?, ?)')
      .run(userId, kind, key, Date.now());
    return res.changes > 0;
  }

  purgeNotificationLog(before: number) {
    this.db.prepare('DELETE FROM notification_log WHERE sent_at < ?').run(before);
  }

  // ------------------------------------------------------------ sharing

  private toShare(r: Row): Share {
    return {
      id: r.id as string,
      ownerId: r.owner_id as string,
      partnerId: r.partner_id as string,
      scopes: parseScopes(r.scopes as string),
      createdAt: r.created_at as number,
    };
  }

  getShare(id: string): Share | null {
    const row = this.db.prepare('SELECT * FROM shares WHERE id = ?').get(id) as Row | undefined;
    return row ? this.toShare(row) : null;
  }

  sharesAsOwner(userId: string): Share[] {
    return (this.db.prepare('SELECT * FROM shares WHERE owner_id = ? ORDER BY created_at').all(userId) as Row[]).map((r) => this.toShare(r));
  }

  sharesAsPartner(userId: string): Share[] {
    return (this.db.prepare('SELECT * FROM shares WHERE partner_id = ? ORDER BY created_at').all(userId) as Row[]).map((r) =>
      this.toShare(r),
    );
  }

  createShare(ownerId: string, partnerId: string, scopes: ShareScope[]): Share {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO shares (id, owner_id, partner_id, scopes, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (owner_id, partner_id) DO UPDATE SET scopes = excluded.scopes`,
      )
      .run(id, ownerId, partnerId, JSON.stringify(scopes), Date.now());
    return this.toShare(
      this.db.prepare('SELECT * FROM shares WHERE owner_id = ? AND partner_id = ?').get(ownerId, partnerId) as Row,
    );
  }

  updateShareScopes(id: string, ownerId: string, scopes: ShareScope[]): boolean {
    return this.db.prepare('UPDATE shares SET scopes = ? WHERE id = ? AND owner_id = ?').run(JSON.stringify(scopes), id, ownerId).changes > 0;
  }

  /** Either side may end a share. */
  deleteShare(id: string, userId: string): boolean {
    return this.db.prepare('DELETE FROM shares WHERE id = ? AND (owner_id = ? OR partner_id = ?)').run(id, userId, userId).changes > 0;
  }

  createInvite(id: string, ownerId: string, scopes: ShareScope[], expiresAt: number) {
    this.db
      .prepare('INSERT INTO share_invites (id, owner_id, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, ownerId, JSON.stringify(scopes), Date.now(), expiresAt);
  }

  getInvite(id: string): ShareInvite | null {
    const r = this.db.prepare('SELECT * FROM share_invites WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      ownerId: r.owner_id as string,
      scopes: parseScopes(r.scopes as string),
      createdAt: r.created_at as number,
      expiresAt: r.expires_at as number,
    };
  }

  listInvites(ownerId: string): ShareInvite[] {
    return (this.db.prepare('SELECT * FROM share_invites WHERE owner_id = ? AND expires_at > ? ORDER BY created_at').all(ownerId, Date.now()) as Row[]).map(
      (r) => ({
        id: r.id as string,
        ownerId: r.owner_id as string,
        scopes: parseScopes(r.scopes as string),
        createdAt: r.created_at as number,
        expiresAt: r.expires_at as number,
      }),
    );
  }

  deleteInvite(id: string, ownerId?: string) {
    if (ownerId) this.db.prepare('DELETE FROM share_invites WHERE id = ? AND owner_id = ?').run(id, ownerId);
    else this.db.prepare('DELETE FROM share_invites WHERE id = ?').run(id);
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

  /** Re-encrypts everything written with DATA_ENCRYPTION_KEY_PREVIOUS. Returns values updated. */
  rotateKeys(): number {
    let n = 0;
    this.tx(() => {
      for (const col of ENCRYPTED_COLUMNS) {
        const rows = this.db.prepare(`SELECT ${col.keys.join(', ')}, ${col.column} AS v FROM ${col.table}`).all() as Row[];
        const where = col.keys.map((k) => `${k} = ?`).join(' AND ');
        const update = this.db.prepare(`UPDATE ${col.table} SET ${col.column} = ? WHERE ${where}`);
        for (const r of rows) {
          const v = r.v as string | null;
          if (!v || !this.cipher.isStale(v)) continue;
          const a = col.aad(r);
          update.run(this.cipher.encrypt(this.cipher.decrypt(v, a), a), ...col.keys.map((k) => r[k] as string));
          n++;
        }
      }
    });
    return n;
  }

  /** Consistent online backup (encrypted content stays encrypted), pruning old ones. */
  backup(dir: string, retentionDays: number): string | null {
    if (retentionDays <= 0) return null;
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
    const file = join(dir, `ebbwell-${stamp}.sqlite`);
    rmSync(file, { force: true });
    this.db.prepare('VACUUM INTO ?').run(file);
    const cutoff = Date.now() - retentionDays * 86_400_000;
    for (const f of readdirSync(dir)) {
      if (!/^ebbwell-.*\.sqlite$/.test(f)) continue;
      const p = join(dir, f);
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
    }
    return file;
  }

  lastBackupAge(dir: string): number {
    try {
      const times = readdirSync(dir)
        .filter((f) => /^ebbwell-.*\.sqlite$/.test(f))
        .map((f) => statSync(join(dir, f)).mtimeMs);
      return times.length ? Date.now() - Math.max(...times) : Infinity;
    } catch {
      return Infinity;
    }
  }
}
