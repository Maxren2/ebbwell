// App lock: a PIN (and optionally biometrics through WebAuthn platform authenticators)
// guards every API call of a session on top of the sign-in. The server enforces
// it, so a stolen or left-open session is useless without the PIN.
//
//  - PINs are 4–8 digits, hashed with scrypt. Five wrong attempts destroy the session,
//    which then requires signing in again (and the PIN again).
//  - A forgotten PIN can only be reset after a fresh sign-in: the local password, or a
//    forced re-authentication at the identity provider (prompt=login), not an SSO cookie.

import { hashSecret as hashPin, verifySecret as verifyPin } from './passwords.ts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { z } from 'zod';
import { lockWindowMs, type Sessions } from './auth.ts';
import type { Config } from './config.ts';
import type { Store } from './db.ts';

export const MAX_FAILED_UNLOCKS = 5;
export const LOCK_TIMEOUTS = [0, 60, 300, 900, 3600] as const;
const CHALLENGE_TTL_MS = 2 * 60_000;
/** Don't rewrite the unlock window on every request. */
const SLIDE_THROTTLE_MS = 15_000;

const pinSchema = z.string().regex(/^\d{4,8}$/, 'PIN must be 4 to 8 digits');
const timeoutSchema = z.number().refine((v) => (LOCK_TIMEOUTS as readonly number[]).includes(v));

export { hashSecret as hashPin, verifySecret as verifyPin } from './passwords.ts';

// ------------------------------------------------------------------ enforcement

/** Routes reachable while the session is locked (the lock screen needs them). */
const LOCKED_ALLOWED = new Set([
  'GET /api/lock',
  'POST /api/lock/unlock',
  'POST /api/lock/lock',
  'POST /api/lock/webauthn/unlock/options',
  'POST /api/lock/webauthn/unlock/verify',
]);

/** Returns true when the request may continue; otherwise replies 423 Locked. */
export function enforceLock(store: Store, request: FastifyRequest, reply: FastifyReply): boolean {
  const lock = store.getLock(request.user!.id);
  if (!lock) return true;
  const route = `${request.method} ${request.url.split('?')[0]}`;
  if (LOCKED_ALLOWED.has(route)) return true;
  const session = request.session!;
  const now = Date.now();
  if (session.unlockedUntil <= now) {
    void reply.code(423).send({ error: 'locked' });
    return false;
  }
  const until = now + lockWindowMs(lock);
  if (until - session.unlockedUntil > SLIDE_THROTTLE_MS) store.setUnlocked(session.id, until);
  return true;
}

// ------------------------------------------------------------------ routes

export function registerLockRoutes(app: FastifyInstance, deps: { config: Config; store: Store; sessions: Sessions }) {
  const { config, store, sessions } = deps;
  const url = new URL(config.APP_URL);
  const rpID = url.hostname;
  const origin = url.origin;
  const challenges = new Map<string, { challenge: string; kind: 'register' | 'unlock'; exp: number }>();
  const unlockLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  const takeChallenge = (sessionId: string, kind: 'register' | 'unlock') => {
    const c = challenges.get(sessionId);
    challenges.delete(sessionId);
    return c && c.kind === kind && c.exp > Date.now() ? c.challenge : null;
  };
  const unlock = (request: FastifyRequest) => {
    const lock = store.getLock(request.user!.id)!;
    store.setUnlocked(request.sessionId!, Date.now() + lockWindowMs(lock));
  };
  const failed = (request: FastifyRequest, reply: FastifyReply) => {
    const n = store.recordFailedUnlock(request.sessionId!);
    if (n >= MAX_FAILED_UNLOCKS) {
      store.audit(request.user!.id, 'lock-lockout');
      sessions.destroy(request, reply);
      return reply.code(401).send({ error: 'locked-out' });
    }
    store.audit(request.user!.id, 'unlock-failed');
    return reply.code(403).send({ error: 'wrong-pin', remaining: MAX_FAILED_UNLOCKS - n });
  };

  app.get('/api/lock', async (request) => {
    const lock = store.getLock(request.user!.id);
    const s = request.session!;
    const locked = !!lock && s.unlockedUntil <= Date.now();
    return {
      enabled: !!lock,
      locked,
      timeoutSec: lock?.timeoutSec ?? null,
      biometrics: lock ? store.listCredentials(request.user!.id).length > 0 : false,
      canReset: s.resetUntil > Date.now(),
      // Credential details only once unlocked.
      credentials: locked
        ? []
        : store.listCredentials(request.user!.id).map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt })),
    };
  });

  /** Set or change the PIN (current PIN, or a fresh re-authentication, required when one exists). */
  app.put('/api/lock', unlockLimit, async (request, reply) => {
    const body = z
      .object({ pin: pinSchema, currentPin: z.string().optional(), timeoutSec: timeoutSchema.default(300) })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const userId = request.user!.id;
    const existing = store.getLock(userId);
    if (existing) {
      const viaReset = request.session!.resetUntil > Date.now();
      const viaPin = body.data.currentPin !== undefined && (await verifyPin(body.data.currentPin, existing.pinHash));
      if (!viaReset && !viaPin) return reply.code(403).send({ error: 'current-pin-required' });
    }
    store.setLock(userId, await hashPin(body.data.pin), body.data.timeoutSec);
    store.clearReset(request.sessionId!);
    store.lockAllSessions(userId, request.sessionId);
    unlock(request);
    store.audit(userId, existing ? 'pin-changed' : 'lock-enabled');
    return { enabled: true };
  });

  app.patch('/api/lock', async (request, reply) => {
    const body = z.object({ timeoutSec: timeoutSchema }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    if (!store.getLock(request.user!.id)) return reply.code(404).send({ error: 'no-lock' });
    store.setLockTimeout(request.user!.id, body.data.timeoutSec);
    unlock(request);
    return { timeoutSec: body.data.timeoutSec };
  });

  app.delete('/api/lock', unlockLimit, async (request, reply) => {
    const body = z.object({ pin: z.string() }).safeParse(request.body);
    const lock = store.getLock(request.user!.id);
    if (!lock) return reply.code(204).send();
    if (!body.success || !(await verifyPin(body.data.pin, lock.pinHash))) return reply.code(403).send({ error: 'wrong-pin' });
    store.removeLock(request.user!.id);
    store.audit(request.user!.id, 'lock-disabled');
    return reply.code(204).send();
  });

  app.post('/api/lock/lock', async (request, reply) => {
    store.setUnlocked(request.sessionId!, 0);
    return reply.code(204).send();
  });

  app.post('/api/lock/unlock', unlockLimit, async (request, reply) => {
    const lock = store.getLock(request.user!.id);
    if (!lock) return reply.code(204).send();
    const body = z.object({ pin: z.string().max(16) }).safeParse(request.body);
    if (!body.success || !(await verifyPin(body.data.pin, lock.pinHash))) return failed(request, reply);
    unlock(request);
    return reply.code(204).send();
  });

  // ---- biometrics (WebAuthn, platform authenticator, user verification required)

  app.post('/api/lock/webauthn/register/options', async (request, reply) => {
    const user = request.user!;
    if (!store.getLock(user.id)) return reply.code(409).send({ error: 'set-pin-first' });
    const options = await generateRegistrationOptions({
      rpName: 'Ebbwell',
      rpID,
      userName: user.name,
      userDisplayName: user.name,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: store.listCredentials(user.id).map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
    });
    challenges.set(request.sessionId!, { challenge: options.challenge, kind: 'register', exp: Date.now() + CHALLENGE_TTL_MS });
    return options;
  });

  app.post('/api/lock/webauthn/register/verify', async (request, reply) => {
    const body = z.object({ response: z.record(z.string(), z.unknown()), name: z.string().max(60).default('This device') }).safeParse(request.body);
    const challenge = takeChallenge(request.sessionId!, 'register');
    if (!body.success || !challenge) return reply.code(400).send({ error: 'invalid' });
    try {
      const result = await verifyRegistrationResponse({
        response: body.data.response as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
      if (!result.verified) return reply.code(400).send({ error: 'not-verified' });
      const c = result.registrationInfo.credential;
      store.addCredential({
        id: c.id,
        userId: request.user!.id,
        publicKey: Buffer.from(c.publicKey).toString('base64url'),
        counter: c.counter,
        transports: c.transports ?? [],
        name: body.data.name,
      });
      store.audit(request.user!.id, 'biometric-added');
      return { id: c.id };
    } catch (err) {
      request.log.warn({ err: (err as Error).message }, 'WebAuthn registration rejected');
      return reply.code(400).send({ error: 'not-verified' });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/lock/webauthn/:id', async (request, reply) => {
    store.deleteCredential(request.user!.id, request.params.id);
    store.audit(request.user!.id, 'biometric-removed');
    return reply.code(204).send();
  });

  app.post('/api/lock/webauthn/unlock/options', unlockLimit, async (request, reply) => {
    const creds = store.listCredentials(request.user!.id);
    if (!creds.length) return reply.code(404).send({ error: 'no-credentials' });
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
    });
    challenges.set(request.sessionId!, { challenge: options.challenge, kind: 'unlock', exp: Date.now() + CHALLENGE_TTL_MS });
    return options;
  });

  app.post('/api/lock/webauthn/unlock/verify', unlockLimit, async (request, reply) => {
    const body = z.object({ response: z.object({ id: z.string() }).loose() }).safeParse(request.body);
    const challenge = takeChallenge(request.sessionId!, 'unlock');
    if (!body.success || !challenge) return reply.code(400).send({ error: 'invalid' });
    const cred = store.listCredentials(request.user!.id).find((c) => c.id === body.data.response.id);
    if (!cred) return failed(request, reply);
    try {
      const result = await verifyAuthenticationResponse({
        response: body.data.response as unknown as AuthenticationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: cred.id,
          publicKey: Buffer.from(cred.publicKey, 'base64url'),
          counter: cred.counter,
          transports: cred.transports as AuthenticatorTransport[],
        },
      });
      if (!result.verified) return failed(request, reply);
      store.updateCredentialCounter(cred.id, result.authenticationInfo.newCounter);
      unlock(request);
      return reply.code(204).send();
    } catch (err) {
      request.log.warn({ err: (err as Error).message }, 'WebAuthn assertion rejected');
      return failed(request, reply);
    }
  });
}
