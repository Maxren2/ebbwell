import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OAuth2Server } from 'oauth2-mock-server';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { Cipher } from '../server/crypto.ts';
import { Store } from '../server/db.ts';
import { VOICE_MODELS } from '../server/voice-models.ts';

const KEY = randomBytes(32).toString('base64');
const APP_URL = 'https://ebbwell.test';

let dir: string;
let store: Store;
let app: FastifyInstance;

async function setup(env: Record<string, string>) {
  dir = mkdtempSync(join(tmpdir(), 'ebbwell-'));
  const config = loadConfig({
    APP_URL,
    DATA_DIR: dir,
    STATIC_DIR: join(dir, 'none'),
    MODELS_DIR: join(dir, 'no-models'),
    DATA_ENCRYPTION_KEY: KEY,
    LOG_LEVEL: 'fatal',
    ...env,
  });
  const cipher = new Cipher(config.DATA_ENCRYPTION_KEY, config.DATA_ENCRYPTION_KEY_PREVIOUS);
  store = new Store(join(dir, 'ebbwell.sqlite'), cipher);
  app = await buildApp({ config, store, cipher });
  // Requests reach the app through its public HTTPS domain, as behind the reverse proxy.
  const rawInject = app.inject.bind(app) as unknown as (o: InjectOptions) => Promise<LightMyRequestResponse>;
  app.inject = ((opts: InjectOptions) => rawInject({ ...opts, headers: { host: 'ebbwell.test', ...opts.headers } })) as unknown as typeof app.inject;
}

async function teardown() {
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

const cookieOf = (res: LightMyRequestResponse, name: string) => res.cookies.find((c) => c.name === name)?.value;

const write = { 'x-ebbwell-csrf': '1', origin: APP_URL, 'content-type': 'application/json' };
const csrf = { 'x-ebbwell-csrf': '1', origin: APP_URL };

// ---------------------------------------------------------------- dev auth

describe('API (dev auth)', () => {
  beforeEach(() => setup({ AUTH_MODE: 'dev', ALLOW_INSECURE_DEV_AUTH: 'true' }));
  afterEach(teardown);

  async function login(ua = 'test-agent') {
    const res = await app.inject({ method: 'GET', url: '/auth/login', headers: { 'user-agent': ua } });
    expect(res.statusCode).toBe(302);
    const token = cookieOf(res, '__Host-ebbwell_session')!;
    expect(token).toBeTruthy();
    const c = res.cookies.find((x) => x.name === '__Host-ebbwell_session')!;
    expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    return { cookie: `__Host-ebbwell_session=${token}` };
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
    const raw = readFileSync(join(dir, 'ebbwell.sqlite')).toString('latin1');
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
    expect(exported).toMatchObject({ app: 'ebbwell', version: 1, days: [{ date: '2026-05-01' }] });

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
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: a });
    expect(me.statusCode).toBe(200);
    expect(me.json().feedbackUrl).toBe('https://github.com/Maxren2/ebbwell/issues/new');
  });

  it('logout destroys the session and answers without delay', async () => {
    const auth = await login();
    const res = await app.inject({ method: 'POST', url: '/auth/logout', headers: auth });
    expect(res.json()).toEqual({ redirect: '/signed-out.html' });
    // Clear-Site-Data made Chrome on Android hold the response (sign-out seemed to do nothing).
    expect(res.headers['clear-site-data']).toBeUndefined();
    expect(res.headers['set-cookie']).toBeDefined();
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
    const d = mkdtempSync(join(tmpdir(), 'ebbwell-'));
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
    const d = mkdtempSync(join(tmpdir(), 'ebbwell-'));
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
  let groups: string[] = ['ebbwell-users'];
  let authTime = () => Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    await oidcServer.issuer.keys.generate('RS256');
    await oidcServer.start(0, '127.0.0.1');
    oidcServer.service.on('beforeTokenSigning', (token) => {
      token.payload.groups = groups;
      token.payload.name = 'Alice';
      token.payload.auth_time = authTime();
    });
  });
  afterAll(() => oidcServer.stop());

  beforeEach(() =>
    setup({
      OIDC_ISSUER: oidcServer.issuer.url!,
      OIDC_CLIENT_ID: 'ebbwell',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_ALLOW_HTTP: 'true',
      OIDC_ALLOWED_GROUPS: 'ebbwell-users',
    }),
  );
  afterEach(teardown);

  async function runFlow(tamper?: (callback: URL) => void, loginUrl = '/auth/oidc') {
    const login = await app.inject({ method: 'GET', url: loginUrl });
    expect(login.statusCode).toBe(302);
    const authorize = new URL(login.headers.location as string);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${APP_URL}/auth/callback`);
    const flow = cookieOf(login, '__Host-ebbwell_flow')!;

    const idp = await fetch(authorize, { redirect: 'manual' });
    const callback = new URL(idp.headers.get('location')!);
    tamper?.(callback);
    return app.inject({
      method: 'GET',
      url: callback.pathname + callback.search,
      headers: { cookie: `__Host-ebbwell_flow=${flow}` },
    });
  }

  it('logs in through the authorization code + PKCE flow', async () => {
    groups = ['ebbwell-users'];
    const res = await runFlow();
    expect(res.statusCode).toBe(302);
    const token = cookieOf(res, '__Host-ebbwell_session')!;
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `__Host-ebbwell_session=${token}` } });
    expect(me.json()).toMatchObject({ name: 'Alice', authMode: 'standard', oidc: true, account: { kind: 'oidc', isAdmin: false } });
  });

  it('rejects a tampered state', async () => {
    const res = await runFlow((u) => u.searchParams.set('state', 'forged'));
    expect(res.statusCode).toBe(400);
    expect(cookieOf(res, '__Host-ebbwell_session')).toBeUndefined();
  });

  it('rejects users outside the allowed groups', async () => {
    groups = ['other'];
    const res = await runFlow();
    expect(res.statusCode).toBe(403);
    expect(cookieOf(res, '__Host-ebbwell_session')).toBeUndefined();
  });

  it('starts locked sessions when a PIN is set; only a fresh re-authentication unlocks and allows a reset', async () => {
    groups = ['ebbwell-users'];
    const sessionOf = (res: LightMyRequestResponse) => ({ cookie: `__Host-ebbwell_session=${cookieOf(res, '__Host-ebbwell_session')}` });
    const first = sessionOf(await runFlow());
    const set = await app.inject({
      method: 'PUT',
      url: '/api/lock',
      headers: { ...first, 'x-ebbwell-csrf': '1', origin: APP_URL, 'content-type': 'application/json' },
      payload: { pin: '482915' },
    });
    expect(set.statusCode).toBe(200);

    // A normal SSO login (e.g. someone picking up the phone) lands locked.
    const second = sessionOf(await runFlow());
    expect((await app.inject({ method: 'GET', url: '/api/days', headers: second })).statusCode).toBe(423);

    // "Forgot PIN": prompt=login + max_age=0, and auth_time must be recent.
    const login = await app.inject({ method: 'GET', url: '/auth/oidc?reauth=1' });
    const authorize = new URL(login.headers.location as string);
    expect(authorize.searchParams.get('prompt')).toBe('login');
    expect(authorize.searchParams.get('max_age')).toBe('0');

    authTime = () => Math.floor(Date.now() / 1000) - 3600; // provider reused an old login
    const stale = sessionOf(await runFlow(undefined, '/auth/oidc?reauth=1'));
    expect((await app.inject({ method: 'GET', url: '/api/days', headers: stale })).statusCode).toBe(423);

    authTime = () => Math.floor(Date.now() / 1000);
    const freshRes = await runFlow(undefined, '/auth/oidc?reauth=1');
    expect(freshRes.headers.location).toBe('/settings#lock');
    const fresh = sessionOf(freshRes);
    expect((await app.inject({ method: 'GET', url: '/api/lock', headers: fresh })).json()).toMatchObject({ locked: false, canReset: true });
  });

  it('rejects a callback without the flow cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=y' });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------- voice input

describe('voice input (on-device Whisper)', () => {
  const base = VOICE_MODELS.base;
  let models: string;
  const login = async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/login' });
    return { cookie: `__Host-ebbwell_session=${cookieOf(res, '__Host-ebbwell_session')}` };
  };
  beforeEach(() => {
    models = mkdtempSync(join(tmpdir(), 'ebbwell-models-'));
    for (const file of Object.keys(base.files)) {
      mkdirSync(join(models, base.id, file, '..'), { recursive: true });
      writeFileSync(join(models, base.id, file), `fake ${file}`);
    }
  });
  afterEach(async () => {
    await teardown();
    rmSync(models, { recursive: true, force: true });
  });

  it('offers the model to signed-in users only, cacheable for good', async () => {
    await setup({ AUTH_MODE: 'dev', ALLOW_INSECURE_DEV_AUTH: 'true', MODELS_DIR: models });
    const auth = await login();
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: auth })).json().voice).toEqual({ model: base.id, sizeMb: base.sizeMb });

    const url = `/api/voice/models/${base.id}/onnx/encoder_model_quantized.onnx`;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('fake onnx/encoder_model_quantized.onnx');
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    // Sizes for the progress bar come from 1-byte range requests.
    const range = await app.inject({ method: 'GET', url, headers: { ...auth, range: 'bytes=0-0' } });
    expect(range.statusCode).toBe(206);
    expect(range.headers['content-range']).toMatch(/\/\d+$/);
    // Nothing outside the model directory.
    expect((await app.inject({ method: 'GET', url: `/api/voice/models/${base.id}/../../ebbwell.sqlite`, headers: auth })).statusCode).not.toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/voice/models/whisper-tiny-ff417702/config.json', headers: auth })).statusCode).toBe(404);
  });

  it('is off when disabled or when the model files are missing', async () => {
    await setup({ AUTH_MODE: 'dev', ALLOW_INSECURE_DEV_AUTH: 'true', MODELS_DIR: models, VOICE_MODEL: 'off' });
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: await login() })).json().voice).toBeNull();
    await teardown();
    await setup({ AUTH_MODE: 'dev', ALLOW_INSECURE_DEV_AUTH: 'true', MODELS_DIR: models, VOICE_MODEL: 'tiny' }); // only base is there
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: await login() })).json().voice).toBeNull();
  });

  it('allows the microphone, WebAssembly and threads, and nothing more', async () => {
    await setup({ AUTH_MODE: 'dev', ALLOW_INSECURE_DEV_AUTH: 'true' });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['content-security-policy']).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(res.headers['content-security-policy']).not.toContain("'unsafe-eval'");
    expect(res.headers['permissions-policy']).toContain('microphone=(self)');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['cross-origin-embedder-policy']).toBe('require-corp');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
  });
});

