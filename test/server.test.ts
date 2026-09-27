import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OAuth2Server } from 'oauth2-mock-server';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { Cipher } from '../server/crypto.ts';
import { Store } from '../server/db.ts';

const KEY = randomBytes(32).toString('base64');
const APP_URL = 'http://lune.test';

let dir: string;
let store: Store;
let app: FastifyInstance;

async function setup(env: Record<string, string>) {
  dir = mkdtempSync(join(tmpdir(), 'lune-'));
  const config = loadConfig({
    APP_URL,
    DATA_DIR: dir,
    STATIC_DIR: join(dir, 'none'),
    DATA_ENCRYPTION_KEY: KEY,
    LOG_LEVEL: 'fatal',
    ...env,
  });
  const cipher = new Cipher(config.DATA_ENCRYPTION_KEY, config.DATA_ENCRYPTION_KEY_PREVIOUS);
  store = new Store(join(dir, 'lune.sqlite'), cipher);
  app = await buildApp({ config, store, cipher });
}

async function teardown() {
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

const cookieOf = (res: LightMyRequestResponse, name: string) => res.cookies.find((c) => c.name === name)?.value;

const write = { 'x-lune-csrf': '1', origin: APP_URL, 'content-type': 'application/json' };
const csrf = { 'x-lune-csrf': '1', origin: APP_URL };

// ---------------------------------------------------------------- dev auth

describe('API (dev auth)', () => {
  beforeEach(() => setup({ AUTH_MODE: 'dev', ALLOW_INSECURE_DEV_AUTH: 'true' }));
  afterEach(teardown);

  async function login(ua = 'test-agent') {
    const res = await app.inject({ method: 'GET', url: '/auth/login', headers: { 'user-agent': ua } });
    expect(res.statusCode).toBe(302);
    const token = cookieOf(res, '__Host-lune_session')!;
    expect(token).toBeTruthy();
    const c = res.cookies.find((x) => x.name === '__Host-lune_session')!;
    expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    return { cookie: `__Host-lune_session=${token}` };
  }

  it('rejects unauthenticated API calls', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/days' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('refuses dev auth without the explicit opt-in', () => {
    expect(() => loadConfig({ APP_URL, DATA_ENCRYPTION_KEY: KEY, AUTH_MODE: 'dev' })).toThrow(/ALLOW_INSECURE_DEV_AUTH/);
  });

  it('refuses weak encryption keys', () => {
    expect(() => loadConfig({ APP_URL, DATA_ENCRYPTION_KEY: 'c2hvcnQ=', AUTH_MODE: 'dev', ALLOW_INSECURE_DEV_AUTH: 'true' })).toThrow(
      /32 random bytes/,
    );
  });

  it('stores, reads and deletes day entries, encrypted at rest', async () => {
    const auth = await login();
    const data = { bleeding: { value: 'heavy' }, note: 'SECRET-NOTE-123', temperature: { value: 36.55, time: '06:30' } };
    const put = await app.inject({ method: 'PUT', url: '/api/days/2026-05-01', headers: { ...auth, ...write }, payload: { data } });
    expect(put.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/days', headers: auth });
    expect(list.json()).toEqual([{ date: '2026-05-01', data }]);

    // Nothing sensitive is readable in the database file.
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const raw = readFileSync(join(dir, 'lune.sqlite')).toString('latin1');
    expect(raw).not.toContain('SECRET-NOTE');
    expect(raw).not.toContain('heavy');
    expect(raw).not.toContain('Dev user');

    const del = await app.inject({ method: 'DELETE', url: '/api/days/2026-05-01', headers: { ...auth, ...csrf } });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/days', headers: auth })).json()).toEqual([]);
  });

  it('deletes a day saved as empty', async () => {
    const auth = await login();
    await app.inject({ method: 'PUT', url: '/api/days/2026-05-01', headers: { ...auth, ...write }, payload: { data: { sex: 'protected' } } });
    await app.inject({ method: 'PUT', url: '/api/days/2026-05-01', headers: { ...auth, ...write }, payload: { data: { symptoms: [] } } });
    expect((await app.inject({ method: 'GET', url: '/api/days', headers: auth })).json()).toEqual([]);
  });

  it('validates input strictly', async () => {
    const auth = await login();
    const bad = [
      { url: '/api/days/2026-02-30', payload: { data: {} } },
      { url: '/api/days/2026-05-01', payload: { data: { temperature: { value: 55 } } } },
      { url: '/api/days/2026-05-01', payload: { data: { unknownField: 1 } } },
      { url: '/api/days/2026-05-01', payload: { data: { bleeding: { value: 'lots' } } } },
    ];
    for (const b of bad) {
      const res = await app.inject({ method: 'PUT', url: b.url, headers: { ...auth, ...write }, payload: b.payload });
      expect(res.statusCode, b.url).toBe(400);
    }
  });

  it('blocks cross-site writes (CSRF)', async () => {
    const auth = await login();
    const payload = { data: { sex: 'protected' } };
    const cases = [
      { ...auth, 'content-type': 'application/json', origin: APP_URL }, // missing custom header
      { ...auth, ...write, origin: 'https://evil.example' },
      { ...auth, ...write, 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of cases) {
      const res = await app.inject({ method: 'PUT', url: '/api/days/2026-05-01', headers, payload });
      expect(res.statusCode).toBe(403);
    }
  });

  it('sets strict security headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('exports JSON/CSV and re-imports', async () => {
    const auth = await login();
    await app.inject({
      method: 'PUT',
      url: '/api/days/2026-05-01',
      headers: { ...auth, ...write },
      payload: { data: { bleeding: { value: 'light' }, note: '=HYPERLINK("x")' } },
    });
    const json = await app.inject({ method: 'GET', url: '/api/export', headers: auth });
    expect(json.headers['content-disposition']).toMatch(/attachment/);
    const exported = json.json();
    expect(exported).toMatchObject({ app: 'lune', version: 1, days: [{ date: '2026-05-01' }] });

    const csv = await app.inject({ method: 'GET', url: '/api/export?format=csv', headers: auth });
    expect(csv.body).toContain(`2026-05-01,light`);
    expect(csv.body).toContain(`"'=HYPERLINK(""x"")"`); // formula neutralised

    await app.inject({ method: 'DELETE', url: '/api/days/2026-05-01', headers: { ...auth, ...csrf } });
    const imp = await app.inject({ method: 'POST', url: '/api/import', headers: { ...auth, ...write }, payload: { ...exported, mode: 'replace' } });
    expect(imp.json()).toEqual({ imported: 1 });
    expect((await app.inject({ method: 'GET', url: '/api/days', headers: auth })).json()).toHaveLength(1);
  });

  it('lists and revokes sessions', async () => {
    const a = await login('phone');
    const b = await login('laptop');
    const list = (await app.inject({ method: 'GET', url: '/api/sessions', headers: a })).json();
    expect(list).toHaveLength(2);
    expect(list.find((s: { current: boolean }) => s.current).userAgent).toBe('phone');
    await app.inject({ method: 'DELETE', url: '/api/sessions/others', headers: { ...a, ...csrf } });
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: b })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: a })).statusCode).toBe(200);
  });

  it('logout destroys the session and clears site data', async () => {
    const auth = await login();
    const res = await app.inject({ method: 'POST', url: '/auth/logout', headers: auth });
    expect(res.headers['clear-site-data']).toContain('storage');
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: auth })).statusCode).toBe(401);
  });

  it('deletes the account and all its data', async () => {
    const auth = await login();
    await app.inject({ method: 'PUT', url: '/api/days/2026-05-01', headers: { ...auth, ...write }, payload: { data: { sex: 'protected' } } });
    const refused = await app.inject({ method: 'DELETE', url: '/api/account', headers: { ...auth, ...write }, payload: {} });
    expect(refused.statusCode).toBe(400);
    const res = await app.inject({ method: 'DELETE', url: '/api/account', headers: { ...auth, ...write }, payload: { confirm: 'DELETE' } });
    expect(res.statusCode).toBe(200);
    const counts = store.db.prepare('SELECT (SELECT count(*) FROM days) d, (SELECT count(*) FROM users) u, (SELECT count(*) FROM sessions) s').get();
    expect(counts).toEqual({ d: 0, u: 0, s: 0 });
  });

  it('writes a consistent backup', async () => {
    const auth = await login();
    await app.inject({ method: 'PUT', url: '/api/days/2026-05-01', headers: { ...auth, ...write }, payload: { data: { sex: 'protected' } } });
    const file = store.backup(join(dir, 'backups'), 7)!;
    const copy = new Store(file, new Cipher(Buffer.from(KEY, 'base64')));
    expect(copy.db.prepare('SELECT count(*) n FROM days').get()).toEqual({ n: 1 });
    copy.close();
  });
});

// ---------------------------------------------------------------- key rotation & isolation

describe('storage', () => {
  it('rotates encryption keys', () => {
    const d = mkdtempSync(join(tmpdir(), 'lune-'));
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const s1 = new Store(join(d, 'db.sqlite'), new Cipher(oldKey));
    const user = s1.upsertUser('sub', 'Alice');
    s1.putDay(user.id, '2026-01-01', { note: 'hello' });
    s1.close();

    const s2 = new Store(join(d, 'db.sqlite'), new Cipher(newKey, oldKey));
    expect(s2.rotateKeys()).toBe(2);
    s2.close();

    const s3 = new Store(join(d, 'db.sqlite'), new Cipher(newKey));
    expect(s3.listDays(user.id)).toEqual([{ date: '2026-01-01', data: { note: 'hello' } }]);
    s3.close();
    rmSync(d, { recursive: true, force: true });
  });

  it('refuses ciphertext moved to another row or user', () => {
    const d = mkdtempSync(join(tmpdir(), 'lune-'));
    const s = new Store(join(d, 'db.sqlite'), new Cipher(randomBytes(32)));
    const alice = s.upsertUser('a', 'Alice');
    const bob = s.upsertUser('b', 'Bob');
    s.putDay(alice.id, '2026-01-01', { note: 'alice' });
    s.putDay(bob.id, '2026-01-01', { note: 'bob' });
    expect(s.listDays(bob.id)).toEqual([{ date: '2026-01-01', data: { note: 'bob' } }]);
    s.db.prepare("UPDATE days SET data_enc = (SELECT data_enc FROM days WHERE user_id = ?) WHERE user_id = ?").run(alice.id, bob.id);
    expect(() => s.listDays(bob.id)).toThrow();
    s.close();
    rmSync(d, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- OIDC

describe('OIDC login (mock Authentik)', () => {
  const oidcServer = new OAuth2Server();
  let groups: string[] = ['lune-users'];

  beforeAll(async () => {
    await oidcServer.issuer.keys.generate('RS256');
    await oidcServer.start(0, '127.0.0.1');
    oidcServer.service.on('beforeTokenSigning', (token) => {
      token.payload.groups = groups;
      token.payload.name = 'Alice';
    });
  });
  afterAll(() => oidcServer.stop());

  beforeEach(() =>
    setup({
      OIDC_ISSUER: oidcServer.issuer.url!,
      OIDC_CLIENT_ID: 'lune',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_ALLOW_HTTP: 'true',
      OIDC_ALLOWED_GROUPS: 'lune-users',
    }),
  );
  afterEach(teardown);

  async function runFlow(tamper?: (callback: URL) => void) {
    const login = await app.inject({ method: 'GET', url: '/auth/login' });
    expect(login.statusCode).toBe(302);
    const authorize = new URL(login.headers.location as string);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${APP_URL}/auth/callback`);
    const flow = cookieOf(login, '__Host-lune_flow')!;

    const idp = await fetch(authorize, { redirect: 'manual' });
    const callback = new URL(idp.headers.get('location')!);
    tamper?.(callback);
    return app.inject({
      method: 'GET',
      url: callback.pathname + callback.search,
      headers: { cookie: `__Host-lune_flow=${flow}` },
    });
  }

  it('logs in through the authorization code + PKCE flow', async () => {
    groups = ['lune-users'];
    const res = await runFlow();
    expect(res.statusCode).toBe(302);
    const token = cookieOf(res, '__Host-lune_session')!;
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `__Host-lune_session=${token}` } });
    expect(me.json()).toMatchObject({ name: 'Alice', authMode: 'oidc' });
  });

  it('rejects a tampered state', async () => {
    const res = await runFlow((u) => u.searchParams.set('state', 'forged'));
    expect(res.statusCode).toBe(400);
    expect(cookieOf(res, '__Host-lune_session')).toBeUndefined();
  });

  it('rejects users outside the allowed groups', async () => {
    groups = ['other'];
    const res = await runFlow();
    expect(res.statusCode).toBe(403);
    expect(cookieOf(res, '__Host-lune_session')).toBeUndefined();
  });

  it('rejects a callback without the flow cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=y' });
    expect(res.statusCode).toBe(400);
  });
});
