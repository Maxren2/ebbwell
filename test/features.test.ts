import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { Cipher, randomToken, sha256 } from '../server/crypto.ts';
import { Store } from '../server/db.ts';
import { MAX_FAILED_UNLOCKS, hashPin, verifyPin } from '../server/lock.ts';
import { runReminders, type PushPayload, type PushResult } from '../server/push.ts';
import { addDays, fromEpochDay } from '../shared/dates.ts';
import { defaultSettings, type DayData, type Settings } from '../shared/schema.ts';

const APP_URL = 'http://ebbwell.test';
const csrf = { 'x-ebbwell-csrf': '1', origin: APP_URL };
const json = { ...csrf, 'content-type': 'application/json' };

let dir: string;
let store: Store;
let app: FastifyInstance;
let pushed: { endpoint: string; payload: PushPayload }[];
let pushResult: PushResult;

const send = async (sub: { endpoint: string }, payload: PushPayload) => {
  pushed.push({ endpoint: sub.endpoint, payload });
  return pushResult;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ebbwell-'));
  const config = loadConfig({
    APP_URL,
    DATA_DIR: dir,
    STATIC_DIR: join(dir, 'none'),
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    AUTH_MODE: 'dev',
    ALLOW_INSECURE_DEV_AUTH: 'true',
    LOG_LEVEL: 'fatal',
  });
  const cipher = new Cipher(config.DATA_ENCRYPTION_KEY);
  store = new Store(join(dir, 'ebbwell.sqlite'), cipher);
  pushed = [];
  pushResult = 'ok';
  app = await buildApp({ config, store, cipher, push: { publicKey: 'test-public-key', send } });
});

afterEach(async () => {
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Creates a user with a fresh session (as after an Authentik login). */
function signIn(name: string, opts: { unlocked?: boolean; reset?: boolean } = {}) {
  const user = store.upsertUser(`sub-${name}`, name);
  const token = randomToken();
  store.createSession(sha256(token), user.id, `${name}-agent`, Date.now() + 86_400_000, {
    unlockedUntil: opts.unlocked ? Date.now() + 60_000 : 0,
    resetUntil: opts.reset ? Date.now() + 60_000 : 0,
  });
  return { user, headers: { cookie: `__Host-ebbwell_session=${token}` }, sessionId: sha256(token) };
}

const get = (url: string, headers: Record<string, string>) => app.inject({ method: 'GET', url, headers });
const post = (url: string, headers: Record<string, string>, payload?: object) =>
  app.inject({ method: 'POST', url, headers: payload ? { ...headers, ...json } : { ...headers, ...csrf }, payload });
const put = (url: string, headers: Record<string, string>, payload: object) =>
  app.inject({ method: 'PUT', url, headers: { ...headers, ...json }, payload });
const del = (url: string, headers: Record<string, string>, payload?: object) =>
  app.inject({ method: 'DELETE', url, headers: payload ? { ...headers, ...json } : { ...headers, ...csrf }, payload });

function logCycles(userId: string, start: string, lengths: number[], extra: (day: number) => DayData = () => ({})) {
  let cursor = start;
  for (const length of lengths) {
    for (let d = 1; d <= length; d++) {
      const data: DayData = { ...extra(d) };
      if (d <= 4) data.bleeding = { value: 'medium' };
      if (Object.keys(data).length) store.putDay(userId, addDays(cursor, d - 1), data);
    }
    cursor = addDays(cursor, length);
  }
  store.putDay(userId, cursor, { bleeding: { value: 'heavy' } });
  return cursor; // start of the current cycle
}

// ---------------------------------------------------------------- app lock

describe('app lock', () => {
  it('hashes PINs with scrypt and verifies them', async () => {
    const h = await hashPin('482915');
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPin('482915', h)).toBe(true);
    expect(await verifyPin('482916', h)).toBe(false);
  });

  it('locks other and new sessions once a PIN is set, and unlocks with the PIN', async () => {
    const a = signIn('Alice');
    const other = { headers: (() => {
      const token = randomToken();
      store.createSession(sha256(token), a.user.id, 'x', Date.now() + 86_400_000, { unlockedUntil: 0, resetUntil: 0 });
      return { cookie: `__Host-ebbwell_session=${token}` };
    })() };

    expect((await get('/api/days', other.headers)).statusCode).toBe(200); // no lock yet
    expect((await put('/api/lock', a.headers, { pin: '12ab' })).statusCode).toBe(400);
    expect((await put('/api/lock', a.headers, { pin: '482915', timeoutSec: 300 })).statusCode).toBe(200);

    expect((await get('/api/days', a.headers)).statusCode).toBe(200); // the session that set it stays unlocked
    expect((await get('/api/days', other.headers)).statusCode).toBe(423);
    expect((await get('/api/lock', other.headers)).json()).toMatchObject({ enabled: true, locked: true, biometrics: false, credentials: [] });

    const wrong = await post('/api/lock/unlock', other.headers, { pin: '000000' });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toEqual({ error: 'wrong-pin', remaining: MAX_FAILED_UNLOCKS - 1 });
    expect((await post('/api/lock/unlock', other.headers, { pin: '482915' })).statusCode).toBe(204);
    expect((await get('/api/days', other.headers)).statusCode).toBe(200);
  });

  it('destroys the session after too many wrong PINs', async () => {
    const a = signIn('Alice', { unlocked: true });
    await put('/api/lock', a.headers, { pin: '482915' });
    await post('/api/lock/lock', a.headers);
    for (let i = 1; i < MAX_FAILED_UNLOCKS; i++) expect((await post('/api/lock/unlock', a.headers, { pin: '111111' })).statusCode).toBe(403);
    expect((await post('/api/lock/unlock', a.headers, { pin: '111111' })).json()).toEqual({ error: 'locked-out' });
    expect((await get('/api/lock', a.headers)).statusCode).toBe(401);
    expect(store.getSession(a.sessionId)).toBeNull();
  });

  it('locks when the unlock window expires and on request', async () => {
    const a = signIn('Alice');
    await put('/api/lock', a.headers, { pin: '482915', timeoutSec: 60 });
    store.setUnlocked(a.sessionId, Date.now() - 1);
    expect((await get('/api/me', a.headers)).statusCode).toBe(423);
    await post('/api/lock/unlock', a.headers, { pin: '482915' });
    expect((await get('/api/me', a.headers)).statusCode).toBe(200);
    await post('/api/lock/lock', a.headers);
    expect((await get('/api/me', a.headers)).statusCode).toBe(423);
  });

  it('requires the current PIN (or a fresh re-authentication) to change it', async () => {
    const a = signIn('Alice');
    await put('/api/lock', a.headers, { pin: '482915' });
    expect((await put('/api/lock', a.headers, { pin: '999999' })).json()).toEqual({ error: 'current-pin-required' });
    expect((await put('/api/lock', a.headers, { pin: '999999', currentPin: '000000' })).statusCode).toBe(403);
    expect((await put('/api/lock', a.headers, { pin: '999999', currentPin: '482915' })).statusCode).toBe(200);

    // Forgot the PIN: a session created right after re-authenticating may reset it once.
    const fresh = signIn('Alice', { unlocked: true, reset: true });
    expect((await get('/api/lock', fresh.headers)).json()).toMatchObject({ canReset: true });
    expect((await put('/api/lock', fresh.headers, { pin: '123456' })).statusCode).toBe(200);
    expect((await get('/api/lock', fresh.headers)).json()).toMatchObject({ canReset: false });
    expect((await put('/api/lock', fresh.headers, { pin: '654321' })).statusCode).toBe(403);
  });

  it('removes the lock only with the PIN', async () => {
    const a = signIn('Alice');
    await put('/api/lock', a.headers, { pin: '482915' });
    expect((await del('/api/lock', a.headers, { pin: '000000' })).statusCode).toBe(403);
    expect((await del('/api/lock', a.headers, { pin: '482915' })).statusCode).toBe(204);
    expect(store.getLock(a.user.id)).toBeNull();
  });

  it('issues WebAuthn challenges only with a PIN set and rejects forged responses', async () => {
    const a = signIn('Alice');
    expect((await post('/api/lock/webauthn/register/options', a.headers)).statusCode).toBe(409);
    await put('/api/lock', a.headers, { pin: '482915' });
    const opts = (await post('/api/lock/webauthn/register/options', a.headers)).json();
    expect(opts).toMatchObject({ rp: { id: 'ebbwell.test', name: 'Ebbwell' }, authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' } });
    const forged = { id: 'abc', rawId: 'abc', type: 'public-key', response: { clientDataJSON: 'e30', attestationObject: 'e30' }, clientExtensionResults: {} };
    expect((await post('/api/lock/webauthn/register/verify', a.headers, { response: forged })).statusCode).toBe(400);
    // No biometric registered: unlock options unavailable.
    expect((await post('/api/lock/webauthn/unlock/options', a.headers)).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------- notifications

describe('notifications', () => {
  const subscription = (n = 1) => ({ endpoint: `https://push.example.com/send/${n}`, keys: { p256dh: 'BPubKeyForTesting123', auth: 'authsecret' } });

  function settingsFor(userId: string, patch: (s: Settings) => void) {
    const s = defaultSettings();
    patch(s);
    store.saveSettings(userId, s);
  }

  it('subscribes devices and sends a test notification', async () => {
    const a = signIn('Alice');
    expect((await get('/api/push', a.headers)).json()).toMatchObject({ publicKey: 'test-public-key', devices: [] });
    const insecure = { subscription: { ...subscription(), endpoint: 'http://push.example.com/x' } };
    expect((await post('/api/push/subscribe', a.headers, insecure)).statusCode).toBe(400);
    expect((await post('/api/push/subscribe', a.headers, { subscription: subscription() })).statusCode).toBe(200);
    expect((await post('/api/push/test', a.headers)).json()).toEqual({ delivered: 1 });
    expect(pushed[0]!.payload).toMatchObject({ title: 'Ebbwell', body: 'Notifications are working.' });

    // Subscriptions are encrypted at rest.
    const raw = store.db.prepare('SELECT data_enc FROM push_subscriptions').get() as { data_enc: string };
    expect(raw.data_enc).not.toContain('push.example.com');
  });

  it('removes subscriptions the push service reports as gone', async () => {
    const a = signIn('Alice');
    await post('/api/push/subscribe', a.headers, { subscription: subscription() });
    pushResult = 'gone';
    expect((await post('/api/push/test', a.headers)).json()).toEqual({ delivered: 0 });
    expect(store.listPushSubscriptions(a.user.id)).toEqual([]);
  });

  it('sends the morning temperature reminder once, in local time, unless already logged', async () => {
    const a = signIn('Alice');
    store.savePushSubscription('s1', a.user.id, subscription(), 'ua');
    settingsFor(a.user.id, (s) => {
      s.notifications.timezone = 'Europe/Zurich';
      s.notifications.temperature = { enabled: true, time: '06:30' };
    });
    // 04:29 UTC = 06:29 in Zurich (summer): too early.
    expect(await runReminders(store, send, new Date('2026-06-10T04:29:00Z'))).toBe(0);
    expect(await runReminders(store, send, new Date('2026-06-10T04:31:00Z'))).toBe(1);
    expect(await runReminders(store, send, new Date('2026-06-10T04:40:00Z'))).toBe(0); // no duplicate
    expect(pushed[0]!.payload).toMatchObject({ body: 'Time for your morning check-in', url: '/day/2026-06-10' });

    store.putDay(a.user.id, '2026-06-11', { temperature: { value: 36.5 } });
    expect(await runReminders(store, send, new Date('2026-06-11T04:35:00Z'))).toBe(0);
    // Outside the 3-hour catch-up window nothing is sent.
    expect(await runReminders(store, send, new Date('2026-06-12T08:00:00Z'))).toBe(0);
  });

  it('reminds before the predicted period, with detailed text when not discreet', async () => {
    const a = signIn('Alice');
    store.savePushSubscription('s1', a.user.id, subscription(), 'ua');
    const current = logCycles(a.user.id, '2026-01-01', [28, 28, 28, 28]);
    settingsFor(a.user.id, (s) => {
      s.notifications.discreet = false;
      s.notifications.period = { enabled: true, daysBefore: 2 };
    });
    const twoDaysBefore = addDays(current, 26);
    expect(await runReminders(store, send, new Date(`${addDays(twoDaysBefore, -1)}T09:05:00Z`))).toBe(0);
    expect(await runReminders(store, send, new Date(`${twoDaysBefore}T09:05:00Z`))).toBe(1);
    expect(pushed.at(-1)!.payload.body).toBe('Your period is expected in 2 days');
  });

  it("reminds a partner before the owner's period", async () => {
    const owner = signIn('Alice');
    const partner = signIn('Bob');
    store.savePushSubscription('p1', partner.user.id, subscription(2), 'ua');
    const current = logCycles(owner.user.id, '2026-01-01', [28, 28, 28, 28]);
    store.createShare(owner.user.id, partner.user.id, []);
    settingsFor(partner.user.id, (s) => {
      s.notifications.discreet = false;
      s.notifications.period.enabled = false;
      s.notifications.partner = { enabled: true, daysBefore: 1 };
    });
    expect(await runReminders(store, send, new Date(`${addDays(current, 27)}T09:00:00Z`))).toBe(1);
    expect(pushed.at(-1)!.payload).toMatchObject({ body: "Alice's period is expected tomorrow" });
  });
});

// ---------------------------------------------------------------- sharing

describe('partner sharing', () => {
  async function share(scopes: string[]) {
    const owner = signIn('Alice Martin');
    const partner = signIn('Bob');
    const invite = (await post('/api/shares/invites', owner.headers, { scopes })).json();
    expect(invite.url).toBe(`${APP_URL}/invite#${invite.code}`);
    const preview = (await post('/api/shares/invites/preview', partner.headers, { code: invite.code })).json();
    expect(preview).toMatchObject({ name: 'Alice', own: false });
    const accepted = await post('/api/shares/accept', partner.headers, { code: invite.code });
    expect(accepted.statusCode).toBe(200);
    return { owner, partner, invite, id: accepted.json().id as string };
  }

  it('accepts an invite once and never with your own invite', async () => {
    const { owner, invite } = await share([]);
    const third = signIn('Carol');
    expect((await post('/api/shares/accept', third.headers, { code: invite.code })).statusCode).toBe(404);
    const own = (await post('/api/shares/invites', owner.headers, { scopes: [] })).json();
    expect((await post('/api/shares/accept', owner.headers, { code: own.code })).statusCode).toBe(400);
    // Invite codes are stored hashed only.
    expect(JSON.stringify(store.db.prepare('SELECT * FROM share_invites').all())).not.toContain(own.code);
  });

  it('shares only what the scopes allow; notes and sex are never shared', async () => {
    const { owner, partner, id } = await share(['wellbeing']);
    // The server only accepts the partner's "today" within a day of its own date.
    const today = fromEpochDay(Math.floor(Date.now() / 86_400_000));
    logCycles(owner.user.id, addDays(today, -87), [28, 28, 28], (d) => ({
      temperature: { value: d < 15 ? 36.4 : 36.8 },
      symptoms: ['cramps'],
      note: 'PRIVATE-NOTE',
      sex: 'unprotected',
    }));
    const view = (await get(`/api/shares/${id}/view?today=${today}`, partner.headers)).json();
    expect(view.owner).toEqual({ name: 'Alice' });
    expect(view.current).toMatchObject({ cycleDay: 4 });
    expect(view.predictions[1]).toHaveProperty('start');
    expect(view.predictions[1]).not.toHaveProperty('fertileStart');
    const body = JSON.stringify(view);
    expect(body).toContain('cramps');
    expect(body).not.toContain('PRIVATE-NOTE');
    expect(body).not.toContain('unprotected');
    expect(body).not.toContain('temperature');
    expect(view.cycles).toEqual([]);

    await put(`/api/shares/${id}`, owner.headers, { scopes: ['fertility', 'history'] });
    const full = (await get(`/api/shares/${id}/view?today=${today}`, partner.headers)).json();
    expect(full.predictions[1]).toHaveProperty('fertileStart');
    expect(JSON.stringify(full)).toContain('temperature');
    expect(JSON.stringify(full)).not.toContain('cramps');
    expect(full.cycles.length).toBeGreaterThan(0);
  });

  it('keeps views private to the partner and lets either side end the share', async () => {
    const { owner, partner, id } = await share([]);
    const stranger = signIn('Mallory');
    expect((await get(`/api/shares/${id}/view`, stranger.headers)).statusCode).toBe(404);
    expect((await get(`/api/shares/${id}/view`, owner.headers)).statusCode).toBe(404);
    expect((await put(`/api/shares/${id}`, partner.headers, { scopes: ['fertility'] })).statusCode).toBe(404);
    expect((await del(`/api/shares/${id}`, stranger.headers)).statusCode).toBe(204);
    expect(store.getShare(id)).not.toBeNull();
    await del(`/api/shares/${id}`, partner.headers);
    expect(store.getShare(id)).toBeNull();
  });

  it("removes shares when the owner's account is deleted", async () => {
    const { owner, id } = await share([]);
    await app.inject({ method: 'DELETE', url: '/api/account', headers: { ...owner.headers, ...json }, payload: { confirm: 'DELETE' } });
    expect(store.getShare(id)).toBeNull();
  });
});
