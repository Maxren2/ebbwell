// Administration: local accounts (create, reset password, disable, delete) and admin rights.
// Admins never see anyone's health data — only account metadata.
// The sign-in policy itself (LOCAL_LOGIN, LOCAL_NETWORKS) is deployment configuration, shown
// read-only here, so a compromised admin account cannot widen where passwords are accepted.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccessPolicy } from './access.ts';
import { changePassword, localAccountsAllowed, passwordErrorText } from './auth.ts';
import { USERNAME_RE, oidcEnabled, type Config } from './config.ts';
import type { Store } from './db.ts';
import { hashSecret, temporaryPassword, verifySecret } from './passwords.ts';
import { checkSecondFactor, renewRecoveryCodes } from './twofactor.ts';

export async function ensureBootstrapAdmin(store: Store, config: Config, log: (msg: string) => void) {
  if (!config.ADMIN_USERNAME || !config.ADMIN_PASSWORD) return;
  if (store.findLocalCredentials(config.ADMIN_USERNAME)) return;
  store.createLocalUser({
    username: config.ADMIN_USERNAME,
    name: config.ADMIN_USERNAME,
    passwordHash: await hashSecret(config.ADMIN_PASSWORD),
    isAdmin: true,
    mustChangePassword: false,
  });
  log(`Created local administrator "${config.ADMIN_USERNAME}". You can now remove ADMIN_PASSWORD from the configuration.`);
}

export function registerAdminRoutes(app: FastifyInstance, deps: { config: Config; store: Store; policy: AccessPolicy }) {
  const { config, store, policy } = deps;

  const requireAdmin = (request: FastifyRequest, reply: FastifyReply) => {
    if (request.user!.isAdmin) return true;
    void reply.code(403).send({ error: 'admin-only' });
    return false;
  };

  // ---- self-service (any local account)

  app.post('/api/account/password', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = request.user!;
    if (user.kind !== 'local') return reply.code(400).send({ error: 'not-a-local-account' });
    const body = z.object({ current: z.string().max(128), password: z.string().max(128), confirm: z.string().max(128) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    const result = await changePassword(store, user, body.data);
    if (result !== 'ok') return reply.code(400).send({ error: 'rejected', reason: result, message: passwordErrorText('en', result) });
    store.deleteUserSessions(user.id, request.sessionId);
    store.audit(user.id, 'password-changed');
    return reply.code(204).send();
  });

  // ---- two-factor authentication (self-service; enrolment is the /auth/2fa/setup page)

  app.get('/api/account/2fa', async (request) => {
    const u = request.user!;
    const state = u.kind === 'local' ? store.getTotp(u.id) : null;
    return {
      available: u.kind === 'local',
      enabled: !!state,
      required: u.kind === 'local' && config.LOCAL_2FA === 'required',
      recoveryCodesLeft: state?.recovery.length ?? 0,
      enabledAt: state?.enabledAt ?? null,
    };
  });

  /** Both the password and a current code (or recovery code) are needed to change 2FA. */
  const confirmIdentity = async (userId: string, body: unknown): Promise<string | null> => {
    const parsed = z.object({ password: z.string().max(128), code: z.string().max(32) }).safeParse(body);
    if (!parsed.success) return 'invalid';
    const hash = store.getPasswordHash(userId);
    if (!hash || !(await verifySecret(parsed.data.password, hash))) return 'wrong-password';
    if (!checkSecondFactor(store, userId, parsed.data.code)) return 'wrong-code';
    return null;
  };
  const twoFactorLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/api/account/2fa/recovery-codes', twoFactorLimit, async (request, reply) => {
    const u = request.user!;
    if (u.kind !== 'local' || !u.twoFactor) return reply.code(400).send({ error: 'not-enabled' });
    const err = await confirmIdentity(u.id, request.body);
    if (err) return reply.code(403).send({ error: err });
    store.audit(u.id, '2fa-recovery-renewed');
    return { codes: renewRecoveryCodes(store, u.id) };
  });

  app.post('/api/account/2fa/disable', twoFactorLimit, async (request, reply) => {
    const u = request.user!;
    if (u.kind !== 'local' || !u.twoFactor) return reply.code(400).send({ error: 'not-enabled' });
    if (config.LOCAL_2FA === 'required') return reply.code(409).send({ error: '2fa-required' });
    const err = await confirmIdentity(u.id, request.body);
    if (err) return reply.code(403).send({ error: err });
    store.setTotp(u.id, null);
    store.audit(u.id, '2fa-disabled');
    return reply.code(204).send();
  });

  // ---- administration

  app.get('/api/admin/users', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return store.listUsers().map((u) => ({
      id: u.id,
      name: u.name,
      username: u.username,
      kind: u.kind,
      isAdmin: u.isAdmin,
      disabled: u.disabled,
      mustChangePassword: u.mustChangePassword,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt || null,
      locked: u.lockedUntil > Date.now(),
      twoFactor: u.twoFactor,
      self: u.id === request.user!.id,
    }));
  });

  app.get('/api/admin/access', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const a = request.access;
    return {
      policy: {
        localLogin: policy.mode,
        localNetworks: policy.networkList,
        twoFactor: config.LOCAL_2FA,
        oidc: oidcEnabled(config),
        publicUrl: config.APP_URL,
      },
      thisConnection: {
        addresses: a.addresses,
        local: a.local,
        viaPublicUrl: a.viaPublicUrl,
        secure: a.secure,
        localLoginAllowed: localAccountsAllowed(a),
      },
    };
  });

  app.post('/api/admin/users', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const body = z
      .object({
        username: z.string().trim().toLowerCase().regex(USERNAME_RE),
        name: z.string().trim().min(1).max(100),
        isAdmin: z.boolean().default(false),
      })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    if (store.findLocalCredentials(body.data.username)) return reply.code(409).send({ error: 'username-taken' });
    const password = temporaryPassword();
    const user = store.createLocalUser({ ...body.data, passwordHash: await hashSecret(password), mustChangePassword: true });
    store.audit(request.user!.id, 'admin-user-created');
    store.audit(user.id, 'account-created-by-admin');
    // Shown once to the admin; the user must replace it at first sign-in.
    return { id: user.id, temporaryPassword: password };
  });

  const target = (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const user = store.getUser(request.params.id);
    if (!user) void reply.code(404).send({ error: 'not-found' });
    return user;
  };
  /** Refuses changes that would leave no active administrator. */
  const keepsAnAdmin = (id: string) => {
    const u = store.getUser(id);
    return !(u?.isAdmin && !u.disabled && store.countActiveAdmins() <= 1);
  };

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/reset-password', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const user = target(request, reply);
    if (!user) return;
    if (user.kind !== 'local') return reply.code(400).send({ error: 'not-a-local-account' });
    if (user.id === request.user!.id) return reply.code(400).send({ error: 'use-account-settings' });
    const password = temporaryPassword();
    store.setPassword(user.id, await hashSecret(password), true);
    store.deleteUserSessions(user.id);
    store.audit(request.user!.id, 'admin-password-reset');
    store.audit(user.id, 'password-reset-by-admin');
    return { temporaryPassword: password };
  });

  /** Lost phone and recovery codes: an admin removes 2FA; the user signs in with the password and enrols again. */
  app.post<{ Params: { id: string } }>('/api/admin/users/:id/reset-2fa', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const user = target(request, reply);
    if (!user) return;
    if (user.id === request.user!.id) return reply.code(400).send({ error: 'use-account-settings' });
    if (!user.twoFactor) return reply.code(400).send({ error: 'not-enabled' });
    store.setTotp(user.id, null);
    store.deleteUserSessions(user.id);
    store.audit(request.user!.id, 'admin-2fa-reset');
    store.audit(user.id, '2fa-reset-by-admin');
    return reply.code(204).send();
  });

  app.patch<{ Params: { id: string } }>('/api/admin/users/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const user = target(request, reply);
    if (!user) return;
    const body = z.object({ disabled: z.boolean().optional(), isAdmin: z.boolean().optional() }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    const self = user.id === request.user!.id;
    if (self) return reply.code(400).send({ error: 'cannot-change-self' });
    if ((body.data.disabled === true || body.data.isAdmin === false) && !keepsAnAdmin(user.id)) {
      return reply.code(409).send({ error: 'last-admin' });
    }
    if (body.data.isAdmin !== undefined) {
      if (user.kind === 'oidc' && config.OIDC_ADMIN_GROUPS.length) return reply.code(409).send({ error: 'managed-by-identity-provider' });
      store.setAdmin(user.id, body.data.isAdmin);
      store.audit(request.user!.id, body.data.isAdmin ? 'admin-granted' : 'admin-revoked');
    }
    if (body.data.disabled !== undefined) {
      store.setDisabled(user.id, body.data.disabled);
      store.audit(request.user!.id, body.data.disabled ? 'admin-user-disabled' : 'admin-user-enabled');
    }
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>('/api/admin/users/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const user = target(request, reply);
    if (!user) return;
    if (user.id === request.user!.id) return reply.code(400).send({ error: 'use-account-settings' });
    if (!keepsAnAdmin(user.id)) return reply.code(409).send({ error: 'last-admin' });
    store.deleteUser(user.id);
    store.audit(request.user!.id, 'admin-user-deleted');
    return reply.code(204).send();
  });
}
