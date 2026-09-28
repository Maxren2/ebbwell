import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions, LightMyRequestResponse } from 'fastify';
import { AccessPolicy, normalizeIp } from '../server/access.ts';
import { buildApp } from '../server/app.ts';
import { MAX_LOGIN_FAILURES } from '../server/auth.ts';
import { loadConfig } from '../server/config.ts';
import { Cipher } from '../server/crypto.ts';
import { Store } from '../server/db.ts';

const PUBLIC = 'ebbwell.test';
const APP_URL = `https://${PUBLIC}`;
const LAN_HOST = '192.168.1.10:30504';
const KEY = randomBytes(32).toString('base64');

// ---------------------------------------------------------------- network policy

function req(opts: { remote?: string; host?: string; xff?: string; realIp?: string; forwarded?: string; xfh?: string; https?: boolean }) {
  const headers: Record<string, string> = { host: opts.host ?? LAN_HOST };
  if (opts.xff) headers['x-forwarded-for'] = opts.xff;
  if (opts.realIp) headers['x-real-ip'] = opts.realIp;
  if (opts.forwarded) headers.forwarded = opts.forwarded;
  if (opts.xfh) headers['x-forwarded-host'] = opts.xfh;
  return { headers, socket: { remoteAddress: opts.remote ?? '192.168.1.20' }, protocol: opts.https ? 'https' : 'http' } as unknown as FastifyRequest;
}

describe('access policy', () => {
  const policy = (mode: 'disabled' | 'local-network' | 'everywhere', extra: { LOCAL_NETWORKS?: string; APP_URL?: string } = {}) =>
    new AccessPolicy({
      LOCAL_LOGIN: mode,
      LOCAL_NETWORKS: extra.LOCAL_NETWORKS ?? loadConfig({ APP_URL, DATA_ENCRYPTION_KEY: KEY, LOCAL_LOGIN: 'local-network' }).LOCAL_NETWORKS,
      APP_URL: extra.APP_URL ?? APP_URL,
    });

  it('normalizes addresses', () => {
    expect(normalizeIp('::ffff:192.168.1.2')).toBe('192.168.1.2');
    expect(normalizeIp('[2001:db8::1]:4711')).toBe('2001:db8::1');
    expect(normalizeIp('10.0.0.1:8080')).toBe('10.0.0.1');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeIp('unknown')).toBeNull();
    expect(normalizeIp('_hidden')).toBeNull();
  });

  it('allows direct local-network access (e.g. http://nas-ip:port)', () => {
    const a = policy('local-network').evaluate(req({}));
    expect(a).toMatchObject({ local: true, viaPublicUrl: false, secure: false, localLoginAllowed: true });
  });

  it('refuses internet clients coming through the reverse proxy', () => {
    const a = policy('local-network').evaluate(req({ remote: '172.18.0.5', host: PUBLIC, xff: '203.0.113.9' }));
    expect(a).toMatchObject({ local: false, viaPublicUrl: true, secure: true, localLoginAllowed: false });
  });

  it('refuses the public domain even from the LAN (no password form on the domain)', () => {
    const a = policy('local-network').evaluate(req({ remote: '172.18.0.5', host: PUBLIC, xff: '192.168.1.20' }));
    expect(a).toMatchObject({ local: true, viaPublicUrl: true, localLoginAllowed: false });
    expect(policy('everywhere').evaluate(req({ host: PUBLIC, xff: '203.0.113.9' })).localLoginAllowed).toBe(true);
  });

  it('fails closed: any public or unparseable forwarded address means "outside"', () => {
    const p = policy('local-network');
    expect(p.evaluate(req({ xff: '10.0.0.1, 203.0.113.9' })).local).toBe(false); // spoofed prefix + real client
    expect(p.evaluate(req({ realIp: '198.51.100.7' })).local).toBe(false);
    expect(p.evaluate(req({ forwarded: 'for="[2001:db8::1]:4711";proto=https' })).local).toBe(false);
    expect(p.evaluate(req({ forwarded: 'for=unknown' })).local).toBe(false);
    expect(p.evaluate(req({ remote: '::ffff:192.168.1.30' })).local).toBe(true);
    expect(p.evaluate(req({ remote: '203.0.113.9' })).local).toBe(false);
  });

  it('detects the public domain in forwarded host headers', () => {
    const p = policy('local-network');
    expect(p.evaluate(req({ xfh: PUBLIC })).viaPublicUrl).toBe(true);
    expect(p.evaluate(req({ forwarded: `for=192.168.1.20;host=${PUBLIC.toUpperCase()}:443` })).viaPublicUrl).toBe(true);
  });

  it('treats an http APP_URL as a LAN-only install (no public domain)', () => {
    const p = policy('local-network', { APP_URL: `http://${LAN_HOST}` });
    expect(p.evaluate(req({})).localLoginAllowed).toBe(true);
  });

  it('honours custom local networks and rejects invalid ones', () => {
    const p = policy('local-network', { LOCAL_NETWORKS: '192.168.50.0/24' });
    expect(p.evaluate(req({ remote: '192.168.50.3' })).local).toBe(true);
    expect(p.evaluate(req({ remote: '192.168.1.20' })).local).toBe(false);
    expect(() => policy('local-network', { LOCAL_NETWORKS: '192.168.1.0/40' })).toThrow(/prefix/);
    expect(() => policy('local-network', { LOCAL_NETWORKS: 'nas.lan' })).toThrow(/invalid address/);
  });

  it('never allows local sign-in when disabled', () => {
    expect(policy('disabled').evaluate(req({})).localLoginAllowed).toBe(false);
  });
});

// ---------------------------------------------------------------- configuration

describe('configuration', () => {
  it('requires at least one way to sign in', () => {
    expect(() => loadConfig({ APP_URL, DATA_ENCRYPTION_KEY: KEY })).toThrow(/no way to sign in/);
    expect(() => loadConfig({ APP_URL, DATA_ENCRYPTION_KEY: KEY, LOCAL_LOGIN: 'local-network' })).not.toThrow();
  });

  it('accepts the legacy AUTH_MODE=oidc', () => {
    const c = loadConfig({ APP_URL, DATA_ENCRYPTION_KEY: KEY, AUTH_MODE: 'oidc', OIDC_ISSUER: 'https://auth.test/', OIDC_CLIENT_ID: 'x', OIDC_CLIENT_SECRET: 'y' });
    expect(c.AUTH_MODE).toBe('standard');
  });

  it('validates the bootstrap administrator', () => {
    const base = { APP_URL, DATA_ENCRYPTION_KEY: KEY, LOCAL_LOGIN: 'local-network' };
    expect(() => loadConfig({ ...base, ADMIN_USERNAME: 'admin' })).toThrow(/go together/);
    expect(() => loadConfig({ ...base, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'short' })).toThrow();
    expect(() => loadConfig({ ...base, ADMIN_USERNAME: 'Bad Name', ADMIN_PASSWORD: 'long-enough-password' })).toThrow();
  });
});

// ---------------------------------------------------------------- sign-in flows

let dir: string;
let store: Store;
let app: FastifyInstance;

async function setup(env: Record<string, string>) {
  dir = mkdtempSync(join(tmpdir(), 'ebbwell-'));
  const config = loadConfig({
    APP_URL,
    DATA_DIR: dir,
    STATIC_DIR: join(dir, 'none'),
    DATA_ENCRYPTION_KEY: KEY,
    LOG_LEVEL: 'fatal',
    // Discovery is lazy: an unreachable issuer is fine as long as nothing starts an OIDC flow.
    OIDC_ISSUER: 'https://auth.invalid/application/o/ebbwell/',
    OIDC_CLIENT_ID: 'ebbwell',
    OIDC_CLIENT_SECRET: 'secret',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'correct horse battery',
    ...env,
  });
  const cipher = new Cipher(config.DATA_ENCRYPTION_KEY);
  store = new Store(join(dir, 'ebbwell.sqlite'), cipher);
  app = await buildApp({ config, store, cipher, push: { publicKey: 'k', send: async () => 'ok' } });
}

afterEach(async () => {
  await app?.close();
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  app = undefined as unknown as FastifyInstance;
  store = undefined as unknown as Store;
  dir = '';
});

/** A browser on the LAN talking to http://192.168.1.10:30504 directly. */
const lan = { headers: { host: LAN_HOST }, remoteAddress: '192.168.1.20' };
/** A browser on the internet, through the reverse proxy and the public domain. */
const internet = { headers: { host: PUBLIC, 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' }, remoteAddress: '172.18.0.5' };

type Where = typeof lan | typeof internet;
const cookieOf = (res: LightMyRequestResponse, name: string) => res.cookies.find((c) => c.name === name);

function call(where: Where, opts: InjectOptions & { cookie?: string }) {
  const { cookie, ...rest } = opts;
  return app.inject({
    ...rest,
    remoteAddress: where.remoteAddress,
    headers: { ...where.headers, ...(cookie ? { cookie } : {}), ...(rest.headers ?? {}) },
  });
}

async function localLogin(where: Where, username: string, password: string, tamperCsrf = false) {
  const page = await call(where, { method: 'GET', url: '/auth/login' });
  const formCookie = page.cookies.find((c) => c.name.endsWith('ebbwell_form'));
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? '';
  const res = await call(where, {
    method: 'POST',
    url: '/auth/local',
    cookie: formCookie ? `${formCookie.name}=${formCookie.value}` : undefined,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ username, password, csrf: tamperCsrf ? 'forged' : csrf }).toString(),
  });
  const session = res.cookies.find((c) => c.name.endsWith('ebbwell_session'));
  return { page, res, cookie: session ? `${session.name}=${session.value}` : undefined, session };
}

const api = (where: Where, cookie: string, method: InjectOptions['method'], url: string, payload?: object) =>
  call(where, {
    method,
    url,
    cookie,
    headers: {
      'x-ebbwell-csrf': '1',
      origin: where === lan ? `http://${LAN_HOST}` : APP_URL,
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    payload,
  });

describe('local accounts (LOCAL_LOGIN=local-network)', () => {
  it('shows the password form on the LAN only; the public domain goes straight to SSO', async () => {
    await setup({ LOCAL_LOGIN: 'local-network' });
    const onLan = await call(lan, { method: 'GET', url: '/auth/login' });
    expect(onLan.statusCode).toBe(200);
    expect(onLan.body).toContain('action="/auth/local"');
    expect(onLan.body).toContain('href="/auth/oidc"');

    const outside = await call(internet, { method: 'GET', url: '/auth/login' });
    expect(outside.statusCode).toBe(302);
    expect(outside.headers.location).toBe('/auth/oidc');
    expect(outside.body).not.toContain('password');
  });

  it('refuses a correct password from outside', async () => {
    await setup({ LOCAL_LOGIN: 'local-network' });
    const res = await call(internet, {
      method: 'POST',
      url: '/auth/local',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'username=admin&password=correct+horse+battery&csrf=x',
    });
    expect(res.statusCode).toBe(403);
    expect(cookieOf(res, '__Host-ebbwell_session')).toBeUndefined();
  });

  it('signs in on the LAN over plain HTTP with a non-Secure, http-only cookie', async () => {
    await setup({ LOCAL_LOGIN: 'local-network' });
    const { res, session, cookie } = await localLogin(lan, 'admin', 'correct horse battery');
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/');
    expect(session).toMatchObject({ name: 'ebbwell_session', httpOnly: true, sameSite: 'Lax' });
    expect(session!.secure).toBeFalsy();
    const me = await call(lan, { method: 'GET', url: '/api/me', cookie: cookie! });
    expect(me.json()).toMatchObject({ account: { kind: 'local', username: 'admin', isAdmin: true } });
  });

  it('rate-limits password attempts per device', async () => {
    await setup({ LOCAL_LOGIN: 'local-network' });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await localLogin(lan, 'admin', 'wrong password!')).res.statusCode);
    expect(statuses.at(-1)).toBe(429);
  });

  it('rejects wrong passwords, unknown users and forged forms, and locks after repeated failures', async () => {
    await setup({ LOCAL_LOGIN: 'local-network' });
    // Each device is rate-limited on its own; the account lockout covers attempts spread across devices.
    const device = (n: number) => ({ ...lan, remoteAddress: `192.168.1.${100 + n}` });
    expect((await localLogin(device(0), 'nobody', 'whatever-password')).res.headers.location).toBe('/auth/login?error=invalid');
    expect((await localLogin(device(0), 'admin', 'correct horse battery', true)).res.headers.location).toBe('/auth/login?error=expired');
    for (let i = 1; i < MAX_LOGIN_FAILURES; i++) {
      expect((await localLogin(device(i), 'admin', 'wrong password!')).res.headers.location).toBe('/auth/login?error=invalid');
    }
    expect((await localLogin(device(20), 'admin', 'wrong password!')).res.headers.location).toBe('/auth/login?error=locked');
    const locked = await localLogin(device(21), 'admin', 'correct horse battery');
    expect(locked.res.headers.location).toBe('/auth/login?error=locked');
    expect(locked.cookie).toBeUndefined();
  });

  it('accepts a real browser form post (Origin: null under no-referrer) but not a cross-site one', async () => {
    await setup({ LOCAL_LOGIN: 'local-network' });
    const page = await call(lan, { method: 'GET', url: '/auth/login' });
    const form = page.cookies.find((c) => c.name === 'ebbwell_form')!;
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!;
    const post = (headers: Record<string, string>) =>
      call(lan, {
        method: 'POST',
        url: '/auth/local',
        cookie: `ebbwell_form=${form.value}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        payload: new URLSearchParams({ username: 'admin', password: 'correct horse battery', csrf }).toString(),
      });
    expect((await post({ origin: 'null', 'sec-fetch-site': 'cross-site' })).headers.location).toBe('/auth/login?error=expired');
    expect((await post({ origin: 'null', 'sec-fetch-site': 'same-origin' })).headers.location).toBe('/');
  });

  it('keeps local accounts usable only where the policy allows them', async () => {
    await setup({ LOCAL_LOGIN: 'local-network' });
    const { session } = await localLogin(lan, 'admin', 'correct horse battery');
    // Same session token presented through the public domain (e.g. an old cookie): refused.
    const res = await call(internet, { method: 'GET', url: '/api/me', cookie: `__Host-ebbwell_session=${session!.value}` });
    expect(res.statusCode).toBe(401);
  });

  it('accepts same-origin writes on the LAN host and rejects other origins', async () => {
    await setup({ LOCAL_LOGIN: 'local-network' });
    const { cookie } = await localLogin(lan, 'admin', 'correct horse battery');
    const ok = await api(lan, cookie!, 'PUT', '/api/days/2026-09-01', { data: { note: 'hi' } });
    expect(ok.statusCode).toBe(200);
    const evil = await call(lan, {
      method: 'PUT',
      url: '/api/days/2026-09-01',
      cookie: cookie!,
      headers: { 'x-ebbwell-csrf': '1', origin: 'http://evil.example', 'content-type': 'application/json' },
      payload: { data: { note: 'x' } },
    });
    expect(evil.statusCode).toBe(403);
  });

  it('forces a new password after a temporary one, then works normally', async () => {
    await setup({ LOCAL_LOGIN: 'local-network' });
    const admin = (await localLogin(lan, 'admin', 'correct horse battery')).cookie!;
    const created = await api(lan, admin, 'POST', '/api/admin/users', { username: 'Alice', name: 'Alice Martin' });
    expect(created.statusCode).toBe(200);
    const temp = created.json().temporaryPassword as string;
    expect(temp).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);

    const first = await localLogin(lan, 'alice', temp);
    expect(first.res.headers.location).toBe('/auth/password');
    const alice = first.cookie!;
    expect((await api(lan, alice, 'GET', '/api/days')).json()).toEqual({ error: 'password-change-required' });
    expect((await api(lan, alice, 'GET', '/api/me')).json()).toMatchObject({ account: { mustChangePassword: true } });

    const form = await call(lan, { method: 'GET', url: '/auth/password', cookie: alice });
    const formCookie = form.cookies.find((c) => c.name === 'ebbwell_form')!;
    const csrf = /name="csrf" value="([^"]+)"/.exec(form.body)![1]!;
    const post = (password: string, confirm: string) =>
      call(lan, {
        method: 'POST',
        url: '/auth/password',
        cookie: `${alice}; ebbwell_form=${formCookie.value}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ csrf, password, confirm }).toString(),
      });
    expect((await post('short', 'short')).body).toContain('Use between 10 and 128 characters');
    expect((await post('alice-is-great-123', 'alice-is-great-123')).body).toContain('include your username');
    const saved = await post('river-lantern-47', 'river-lantern-47');
    expect(saved.statusCode).toBe(303);
    expect((await api(lan, alice, 'GET', '/api/days')).statusCode).toBe(200);

    expect((await localLogin(lan, 'alice', temp)).res.headers.location).toBe('/auth/login?error=invalid');
    expect((await localLogin(lan, 'alice', 'river-lantern-47')).res.headers.location).toBe('/');
  });

  it('lets users change their own password from the app', async () => {
    await setup({ LOCAL_LOGIN: 'local-network' });
    const admin = (await localLogin(lan, 'admin', 'correct horse battery')).cookie!;
    const wrong = await api(lan, admin, 'POST', '/api/account/password', { current: 'nope', password: 'new-password-1', confirm: 'new-password-1' });
    expect(wrong.json()).toMatchObject({ message: 'Your current password is wrong.' });
    const ok = await api(lan, admin, 'POST', '/api/account/password', { current: 'correct horse battery', password: 'new-password-1', confirm: 'new-password-1' });
    expect(ok.statusCode).toBe(204);
    expect((await localLogin(lan, 'admin', 'new-password-1')).res.headers.location).toBe('/');
  });

  it('starts password sign-ins unlocked when an app lock exists (the password is a fresh proof)', async () => {
    await setup({ LOCAL_LOGIN: 'local-network' });
    const first = (await localLogin(lan, 'admin', 'correct horse battery')).cookie!;
    await api(lan, first, 'PUT', '/api/lock', { pin: '482915' });
    const second = (await localLogin(lan, 'admin', 'correct horse battery')).cookie!;
    expect((await api(lan, second, 'GET', '/api/lock')).json()).toMatchObject({ enabled: true, locked: false, canReset: true });
  });
});

describe('administration', () => {
  it('is admin-only and protects the last administrator', async () => {
    await setup({ LOCAL_LOGIN: 'local-network' });
    const admin = (await localLogin(lan, 'admin', 'correct horse battery')).cookie!;
    const bob = (await api(lan, admin, 'POST', '/api/admin/users', { username: 'bob', name: 'Bob' })).json();
    const bobCookie = (await (async () => {
      const first = await localLogin(lan, 'bob', bob.temporaryPassword);
      await api(lan, first.cookie!, 'GET', '/api/me');
      store.setPassword(bob.id, store.getPasswordHash(bob.id)!, false); // skip the forced change for this test
      return first;
    })()).cookie!;

    expect((await api(lan, bobCookie, 'GET', '/api/admin/users')).statusCode).toBe(403);

    const users = (await api(lan, admin, 'GET', '/api/admin/users')).json() as { id: string; username: string; self: boolean }[];
    const me = users.find((u) => u.self)!;
    expect((await api(lan, admin, 'PATCH', `/api/admin/users/${me.id}`, { isAdmin: false })).json()).toEqual({ error: 'cannot-change-self' });
    expect((await api(lan, admin, 'DELETE', `/api/admin/users/${me.id}`)).json()).toEqual({ error: 'use-account-settings' });
    expect((await api(lan, admin, 'DELETE', '/api/account', { confirm: 'DELETE' })).json()).toEqual({ error: 'last-admin' });

    // Promote Bob, then the original admin may step down.
    expect((await api(lan, admin, 'PATCH', `/api/admin/users/${bob.id}`, { isAdmin: true })).statusCode).toBe(204);
    expect((await api(lan, bobCookie, 'PATCH', `/api/admin/users/${me.id}`, { isAdmin: false })).statusCode).toBe(204);
    expect((await api(lan, admin, 'GET', '/api/admin/users')).statusCode).toBe(403);
    expect((await api(lan, bobCookie, 'PATCH', `/api/admin/users/${me.id}`, { isAdmin: true })).statusCode).toBe(204);
  });

  it('disables accounts (revoking their sessions) and resets passwords', async () => {
    await setup({ LOCAL_LOGIN: 'local-network' });
    const admin = (await localLogin(lan, 'admin', 'correct horse battery')).cookie!;
    const carol = (await api(lan, admin, 'POST', '/api/admin/users', { username: 'carol', name: 'Carol' })).json();
    const carolCookie = (await localLogin(lan, 'carol', carol.temporaryPassword)).cookie!;

    await api(lan, admin, 'PATCH', `/api/admin/users/${carol.id}`, { disabled: true });
    expect((await api(lan, carolCookie, 'GET', '/api/me')).statusCode).toBe(401);
    expect((await localLogin(lan, 'carol', carol.temporaryPassword)).res.headers.location).toBe('/auth/login?error=disabled');

    await api(lan, admin, 'PATCH', `/api/admin/users/${carol.id}`, { disabled: false });
    const reset = (await api(lan, admin, 'POST', `/api/admin/users/${carol.id}/reset-password`)).json();
    expect((await localLogin(lan, 'carol', carol.temporaryPassword)).res.headers.location).toBe('/auth/login?error=invalid');
    expect((await localLogin(lan, 'carol', reset.temporaryPassword)).res.headers.location).toBe('/auth/password');
    expect((await api(lan, admin, 'POST', '/api/admin/users', { username: 'carol', name: 'Again' })).json()).toEqual({ error: 'username-taken' });
  });

  it('reports how this connection is classified', async () => {
    await setup({ LOCAL_LOGIN: 'local-network' });
    const admin = (await localLogin(lan, 'admin', 'correct horse battery')).cookie!;
    const access = (await api(lan, admin, 'GET', '/api/admin/access')).json();
    expect(access).toMatchObject({
      policy: { localLogin: 'local-network', oidc: true, publicUrl: APP_URL },
      thisConnection: { local: true, viaPublicUrl: false, secure: false, localLoginAllowed: true },
    });
  });

  it('syncs the admin flag of identity-provider users from their groups', () => {
    dir = mkdtempSync(join(tmpdir(), 'ebbwell-'));
    store = new Store(join(dir, 'db.sqlite'), new Cipher(randomBytes(32)));
    expect(store.upsertUser('iss|a', 'A', { isAdmin: true }).isAdmin).toBe(true);
    expect(store.upsertUser('iss|a', 'A', { isAdmin: false }).isAdmin).toBe(false);
    expect(store.upsertUser('iss|a', 'A').isAdmin).toBe(false); // unchanged when groups aren't configured
    app = undefined as unknown as FastifyInstance;
  });
});

describe('other policies', () => {
  it('LOCAL_LOGIN=disabled: no password form anywhere', async () => {
    await setup({ LOCAL_LOGIN: 'disabled' });
    expect((await call(lan, { method: 'GET', url: '/auth/login' })).headers.location).toBe('/auth/oidc');
    const post = await call(lan, {
      method: 'POST',
      url: '/auth/local',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'username=admin&password=correct+horse+battery&csrf=x',
    });
    expect(post.statusCode).toBe(403);
  });

  it('LOCAL_LOGIN=everywhere: allowed on the public domain with a Secure cookie, never over plain HTTP from outside', async () => {
    await setup({ LOCAL_LOGIN: 'everywhere' });
    const { session } = await localLogin(internet, 'admin', 'correct horse battery');
    expect(session).toMatchObject({ name: '__Host-ebbwell_session', secure: true });

    const plainOutside = { headers: { host: '198.51.100.1:30504' }, remoteAddress: '203.0.113.50' };
    const page = await call(plainOutside, { method: 'GET', url: '/auth/login' });
    expect(page.headers.location).toBe('/auth/oidc');
  });

  it('works without any identity provider on a LAN-only install', async () => {
    await setup({ LOCAL_LOGIN: 'local-network', APP_URL: `http://${LAN_HOST}`, OIDC_ISSUER: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '' });
    const onLan = await call(lan, { method: 'GET', url: '/auth/login' });
    expect(onLan.body).toContain('action="/auth/local"');
    expect(onLan.body).not.toContain('/auth/oidc');
    const outside = await call({ headers: { host: LAN_HOST }, remoteAddress: '203.0.113.9' }, { method: 'GET', url: '/auth/login' });
    expect(outside.statusCode).toBe(403);
  });
});
