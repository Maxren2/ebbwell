import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../server/app.ts';
import { MAX_LOGIN_FAILURES } from '../server/auth.ts';
import { loadConfig } from '../server/config.ts';
import { Cipher } from '../server/crypto.ts';
import { Store } from '../server/db.ts';
import { base32Decode, base32Encode, currentStep, hotp, verifyTotp } from '../server/totp.ts';

// ---------------------------------------------------------------- TOTP primitives

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  const rfcSecret = Buffer.from('12345678901234567890');

  it('matches the RFC test vectors', () => {
    // RFC 6238 appendix B (SHA1), truncated to 6 digits: T=59 → 94287082, T=1111111109 → 07081804.
    expect(hotp(rfcSecret, Math.floor(59 / 30), 8)).toBe('94287082');
    expect(hotp(rfcSecret, Math.floor(1111111109 / 30), 8)).toBe('07081804');
    expect(hotp(rfcSecret, Math.floor(1234567890 / 30), 8)).toBe('89005924');
    // RFC 4226 appendix D, counter 0..2.
    expect([0, 1, 2].map((c) => hotp(rfcSecret, c))).toEqual(['755224', '287082', '359152']);
  });

  it('round-trips base32', () => {
    expect(base32Encode(rfcSecret)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')).toEqual(rfcSecret);
  });

  it('accepts ±1 step and refuses replays', () => {
    const secret = base32Encode(rfcSecret);
    const now = Date.UTC(2026, 8, 28, 12, 0, 10);
    const step = currentStep(now);
    const code = hotp(rfcSecret, step);
    expect(verifyTotp(secret, code, -1, now)).toBe(step);
    expect(verifyTotp(secret, hotp(rfcSecret, step - 1), -1, now)).toBe(step - 1);
    expect(verifyTotp(secret, hotp(rfcSecret, step + 1), -1, now)).toBe(step + 1);
    expect(verifyTotp(secret, hotp(rfcSecret, step + 2), -1, now)).toBeNull();
    expect(verifyTotp(secret, code, step, now)).toBeNull(); // already used
    expect(verifyTotp(secret, 'abcdef', -1, now)).toBeNull();
  });
});

// ---------------------------------------------------------------- flows

const APP_URL = 'https://ebbwell.test';
const lan = { headers: { host: '192.168.1.10:30504' }, remoteAddress: '192.168.1.20' };
let dir: string;
let store: Store;
let app: FastifyInstance;

async function setup(env: Record<string, string> = {}) {
  dir = mkdtempSync(join(tmpdir(), 'ebbwell-'));
  const config = loadConfig({
    APP_URL,
    DATA_DIR: dir,
    STATIC_DIR: join(dir, 'none'),
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    LOG_LEVEL: 'fatal',
    LOCAL_LOGIN: 'local-network',
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
});

/** Minimal cookie jar per simulated browser. */
function browser(remoteAddress = lan.remoteAddress) {
  const jar = new Map<string, string>();
  const send = async (opts: InjectOptions) => {
    const res = await app.inject({
      ...opts,
      remoteAddress,
      headers: {
        ...lan.headers,
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(opts.headers ?? {}),
      },
    });
    for (const c of res.cookies) {
      if (c.value === '' || (c.maxAge !== undefined && c.maxAge <= 0) || (c.expires && c.expires.getTime() < Date.now())) jar.delete(c.name);
      else jar.set(c.name, c.value);
    }
    return res;
  };
  const form = async (url: string, fields: Record<string, string>, formUrl = url) => {
    const page = await send({ method: 'GET', url: formUrl });
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? '';
    return send({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ ...fields, csrf }).toString(),
    });
  };
  const api = (method: InjectOptions['method'], url: string, payload?: object) =>
    send({
      method,
      url,
      headers: { 'x-ebbwell-csrf': '1', origin: 'http://192.168.1.10:30504', ...(payload ? { 'content-type': 'application/json' } : {}) },
      payload,
    });
  return { jar, send, form, api, login: (u: string, p: string) => form('/auth/local', { username: u, password: p }, '/auth/login') };
}

/** Enrols 2FA from the setup page; returns the secret and recovery codes. */
async function enrol(b: ReturnType<typeof browser>, password?: string) {
  const page = await b.send({ method: 'GET', url: '/auth/2fa/setup' });
  expect(page.body).toContain('<svg');
  const secret = /<code>([A-Z2-7 ]+)<\/code>/.exec(page.body)![1]!.replace(/ /g, '');
  const code = hotp(base32Decode(secret), currentStep());
  const res = await b.form('/auth/2fa/setup', { code, ...(password ? { password } : {}) }, '/auth/2fa/setup');
  const codes = [...res.body.matchAll(/<li><code>([a-z0-9-]+)<\/code><\/li>/g)].map((m) => m[1]!);
  return { secret, codes, res };
}

describe('two-factor sign-in', () => {
  it('enrols, then requires a code after the password; replays and bad codes are refused', async () => {
    await setup();
    const a = browser();
    await a.login('admin', 'correct horse battery');

    const wrongPw = await enrol(a, 'not my password');
    expect(wrongPw.res.body).toContain('current password is wrong');
    const { secret, codes } = await enrol(a, 'correct horse battery');
    expect(codes).toHaveLength(10);
    expect(store.getUser(store.findLocalCredentials('admin')!.user.id)!.twoFactor).toBe(true);
    // Stored encrypted: the secret isn't readable in the database.
    const raw = store.db.prepare("SELECT totp_enc FROM users WHERE username = 'admin'").get() as { totp_enc: string };
    expect(raw.totp_enc).not.toContain(secret);

    const b = browser();
    const pw = await b.login('admin', 'correct horse battery');
    expect(pw.headers.location).toBe('/auth/2fa');
    expect([...b.jar.keys()].some((k) => k.endsWith('ebbwell_session'))).toBe(false);

    expect((await b.form('/auth/2fa', { code: '000000' })).headers.location).toBe('/auth/2fa?error=invalid');
    // The code used during enrolment can't be replayed.
    const used = hotp(base32Decode(secret), currentStep());
    expect((await b.form('/auth/2fa', { code: used })).headers.location).toBe('/auth/2fa?error=invalid');
    const next = hotp(base32Decode(secret), currentStep() + 1);
    const ok = await b.form('/auth/2fa', { code: next });
    expect(ok.headers.location).toBe('/');
    expect((await b.api('GET', '/api/me')).json()).toMatchObject({ account: { twoFactor: true } });
  });

  it('accepts each recovery code once', async () => {
    await setup();
    const a = browser();
    await a.login('admin', 'correct horse battery');
    const { codes } = await enrol(a, 'correct horse battery');

    const b = browser();
    await b.login('admin', 'correct horse battery');
    expect((await b.form('/auth/2fa', { code: codes[0]!.toUpperCase().replace(/-/g, ' ') })).headers.location).toBe('/');

    const c = browser();
    await c.login('admin', 'correct horse battery');
    expect((await c.form('/auth/2fa', { code: codes[0]! })).headers.location).toBe('/auth/2fa?error=invalid');
    expect((await c.api('GET', '/api/account/2fa')).statusCode).toBe(401);
  });

  it('refuses the code step without a fresh password step', async () => {
    await setup();
    const b = browser();
    expect((await b.send({ method: 'GET', url: '/auth/2fa' })).headers.location).toBe('/auth/login');
    const forged = await b.send({
      method: 'POST',
      url: '/auth/2fa',
      cookie: 'ebbwell_2fa=v1.forged.x.y',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'code=123456&csrf=x',
    } as InjectOptions);
    expect(forged.headers.location).toBe('/auth/login?error=expired');
  });

  it('counts wrong codes towards the account lockout', async () => {
    await setup();
    const a = browser();
    await a.login('admin', 'correct horse battery');
    await enrol(a, 'correct horse battery');

    const b = browser('192.168.1.50');
    let last = '';
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      const attempt = browser(`192.168.1.${60 + i}`); // spread across devices (rate limits are per device)
      await attempt.login('admin', 'correct horse battery');
      last = (await attempt.form('/auth/2fa', { code: '000000' })).headers.location as string;
    }
    expect(last).toBe('/auth/login?error=locked');
    expect((await b.login('admin', 'correct horse battery')).headers.location).toBe('/auth/login?error=locked');
  });
});

describe('two-factor management', () => {
  it('renews recovery codes and disables 2FA only with password + code', async () => {
    await setup();
    const a = browser();
    await a.login('admin', 'correct horse battery');
    const { secret, codes } = await enrol(a, 'correct horse battery');
    // Enrolment signed out other devices but kept this one.
    expect((await a.api('GET', '/api/account/2fa')).json()).toMatchObject({ enabled: true, recoveryCodesLeft: 10, required: false });

    expect((await a.api('POST', '/api/account/2fa/recovery-codes', { password: 'correct horse battery', code: '000000' })).json()).toEqual({ error: 'wrong-code' });
    const renewed = await a.api('POST', '/api/account/2fa/recovery-codes', { password: 'correct horse battery', code: codes[1]! });
    expect(renewed.json().codes).toHaveLength(10);
    expect(renewed.json().codes).not.toContain(codes[2]);

    expect((await a.api('POST', '/api/account/2fa/disable', { password: 'nope', code: '000000' })).json()).toEqual({ error: 'wrong-password' });
    const next = hotp(base32Decode(secret), currentStep() + 1);
    expect((await a.api('POST', '/api/account/2fa/disable', { password: 'correct horse battery', code: next })).statusCode).toBe(204);
    expect((await a.api('GET', '/api/account/2fa')).json()).toMatchObject({ enabled: false });
  });

  it('lets an administrator reset a user who lost their phone', async () => {
    await setup();
    const admin = browser();
    await admin.login('admin', 'correct horse battery');
    const bob = (await admin.api('POST', '/api/admin/users', { username: 'bob', name: 'Bob' })).json();

    const b = browser();
    await b.login('bob', bob.temporaryPassword);
    await b.form('/auth/password', { password: 'amber-harbor-lights-3', confirm: 'amber-harbor-lights-3' });
    await enrol(b, 'amber-harbor-lights-3');
    expect(((await admin.api('GET', '/api/admin/users')).json() as { username: string; twoFactor: boolean }[]).find((u) => u.username === 'bob')!.twoFactor).toBe(true);

    expect((await admin.api('POST', `/api/admin/users/${bob.id}/reset-2fa`)).statusCode).toBe(204);
    expect((await b.api('GET', '/api/me')).statusCode).toBe(401); // sessions revoked
    expect((await browser().login('bob', 'amber-harbor-lights-3')).headers.location).toBe('/');
  });
});

describe('LOCAL_2FA=required', () => {
  it('forces enrolment right after the password, before anything else works', async () => {
    await setup({ LOCAL_2FA: 'required' });
    const a = browser();
    expect((await a.login('admin', 'correct horse battery')).headers.location).toBe('/auth/2fa/setup');
    expect((await a.api('GET', '/api/days')).json()).toEqual({ error: '2fa-setup-required' });
    expect((await a.api('GET', '/api/me')).json()).toMatchObject({ account: { twoFactor: false, twoFactorSetupRequired: true } });

    const page = await a.send({ method: 'GET', url: '/auth/2fa/setup' });
    expect(page.body).toContain('requires two-factor');
    expect(page.body).not.toContain('name="password"'); // the password was just entered
    const { secret } = await enrol(a);
    expect((await a.api('GET', '/api/days')).statusCode).toBe(200);

    const next = hotp(base32Decode(secret), currentStep() + 1);
    expect((await a.api('POST', '/api/account/2fa/disable', { password: 'correct horse battery', code: next })).json()).toEqual({ error: '2fa-required' });
  });

  it('chains a temporary-password change and then enrolment for new accounts', async () => {
    await setup({ LOCAL_2FA: 'required' });
    const admin = browser();
    await admin.login('admin', 'correct horse battery');
    await enrol(admin);
    const carol = (await admin.api('POST', '/api/admin/users', { username: 'carol', name: 'Carol' })).json();

    const c = browser();
    expect((await c.login('carol', carol.temporaryPassword)).headers.location).toBe('/auth/password');
    const changed = await c.form('/auth/password', { password: 'meadow-quiet-river-9', confirm: 'meadow-quiet-river-9' });
    expect(changed.headers.location).toBe('/auth/2fa/setup');
  });
});
