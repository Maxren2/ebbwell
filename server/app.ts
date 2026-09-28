import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { DayDataSchema, SettingsSchema, isEmptyDay, isoDate, type DayEntry } from '../shared/schema.ts';
import { AccessPolicy, type AccessInfo } from './access.ts';
import { ensureBootstrapAdmin, registerAdminRoutes } from './admin.ts';
import { Sessions, endSessionUrl, localAccountsAllowed, registerAuth } from './auth.ts';
import { oidcEnabled, type Config } from './config.ts';
import type { Cipher } from './crypto.ts';
import type { Store } from './db.ts';
import { enforceLock, registerLockRoutes } from './lock.ts';
import { twoFactorSetupRequired } from './twofactor.ts';
import { registerPushRoutes, vapidKeys, webPushSender, type PushSender } from './push.ts';
import { registerSharingRoutes } from './sharing.ts';

export const EXPORT_VERSION = 1;

const ImportSchema = z.object({
  app: z.literal('ebbwell'),
  version: z.literal(EXPORT_VERSION),
  settings: SettingsSchema.optional(),
  days: z.array(z.object({ date: isoDate, data: DayDataSchema })).max(50_000),
  mode: z.enum(['merge', 'replace']).default('merge'),
});

export interface AppDeps {
  config: Config;
  store: Store;
  cipher: Cipher;
  /** Injected in tests; defaults to real Web Push with the instance's VAPID keys. */
  push?: { publicKey: string; send: PushSender };
}

/** Push services require an https: or mailto: contact. */
export function vapidSubject(config: Config): string {
  if (config.VAPID_SUBJECT) return config.VAPID_SUBJECT;
  return config.APP_URL.startsWith('https://') ? config.APP_URL : 'mailto:ebbwell@localhost';
}

export function defaultPush(store: Store, config: Config): { publicKey: string; send: PushSender } {
  const keys = vapidKeys(store, config);
  return { publicKey: keys.publicKey, send: webPushSender(keys, vapidSubject(config)) };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, store } = deps;
  const push = deps.push ?? defaultPush(store, config);
  const appOrigin = new URL(config.APP_URL).origin;

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Never log cookies, auth codes or bodies.
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      serializers: {
        req: (req) => ({ method: req.method, url: req.url.split('?')[0] }),
      },
    },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  // ---------------------------------------------------------------- security headers
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('Content-Security-Policy', csp);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    if (config.HSTS) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const url = request.url;
    if (url.startsWith('/api/') || url.startsWith('/auth/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // ---------------------------------------------------------------- auth
  // Where is this request coming from (local network? through the public domain?).
  const policy = new AccessPolicy(config);
  app.decorateRequest('access', null as unknown as AccessInfo);
  app.addHook('onRequest', async (request) => {
    request.access = policy.evaluate(request);
  });

  const sessions = new Sessions(store, config);
  await registerAuth(app, { ...deps, sessions, policy });
  await ensureBootstrapAdmin(store, config, (msg) => app.log.info(msg));

  // Every /api route needs a session; writes also need same-origin proof (CSRF).
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const origin = request.headers.origin;
      const site = request.headers['sec-fetch-site'];
      // The public origin, or the request's own origin (direct local-network access, e.g. http://nas:port).
      const ownOrigin = `${request.access.secure ? 'https' : 'http'}://${request.headers.host}`;
      if ((origin && origin !== appOrigin && origin !== ownOrigin) || (site && site !== 'same-origin') || request.headers['x-ebbwell-csrf'] !== '1') {
        return reply.code(403).send({ error: 'forbidden' });
      }
    }
    if (!sessions.resolve(request, reply)) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    const user = request.user!;
    // Local accounts only work where the sign-in policy allows passwords (e.g. never via the public domain).
    if (user.kind === 'local' && !localAccountsAllowed(request.access)) {
      return reply.code(401).send({ error: 'local-account-not-allowed-here' });
    }
    if (user.mustChangePassword && request.url !== '/api/me') {
      return reply.code(403).send({ error: 'password-change-required' });
    }
    if (twoFactorSetupRequired(config, user) && request.url !== '/api/me') {
      return reply.code(403).send({ error: '2fa-setup-required' });
    }
    // App lock (PIN / biometrics): locked sessions only reach the unlock endpoints.
    if (!enforceLock(store, request, reply)) return reply;
  });

  app.get('/healthz', { config: { rateLimit: false } }, async () => 'ok');

  // ---------------------------------------------------------------- API
  const uid = (request: { user?: { id: string } }) => request.user!.id;

  app.get('/api/me', async (request) => {
    const u = request.user!;
    return {
      name: u.name,
      settings: store.getSettings(uid(request)),
      authMode: config.AUTH_MODE,
      account: {
        kind: u.kind,
        username: u.username,
        isAdmin: u.isAdmin,
        mustChangePassword: u.mustChangePassword,
        twoFactor: u.twoFactor,
        twoFactorSetupRequired: twoFactorSetupRequired(config, u),
      },
      oidc: oidcEnabled(config),
    };
  });

  app.put('/api/settings', async (request, reply) => {
    const parsed = SettingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', issues: parsed.error.issues });
    store.saveSettings(uid(request), parsed.data);
    return parsed.data;
  });

  app.get('/api/days', async (request) => store.listDays(uid(request)));

  app.put<{ Params: { date: string } }>('/api/days/:date', async (request, reply) => {
    if (!isoDate.safeParse(request.params.date).success) return reply.code(400).send({ error: 'invalid-date' });
    const parsed = z.object({ data: DayDataSchema }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', issues: parsed.error.issues });
    if (isEmptyDay(parsed.data.data)) store.deleteDay(uid(request), request.params.date);
    else store.putDay(uid(request), request.params.date, parsed.data.data);
    return { date: request.params.date, data: parsed.data.data };
  });

  app.delete<{ Params: { date: string } }>('/api/days/:date', async (request, reply) => {
    if (!isoDate.safeParse(request.params.date).success) return reply.code(400).send({ error: 'invalid-date' });
    store.deleteDay(uid(request), request.params.date);
    return reply.code(204).send();
  });

  app.get<{ Querystring: { format?: string } }>('/api/export', async (request, reply) => {
    const userId = uid(request);
    const days = store.listDays(userId);
    store.audit(userId, 'export');
    const stamp = new Date().toISOString().slice(0, 10);
    if (request.query.format === 'csv') {
      reply.header('Content-Disposition', `attachment; filename="ebbwell-${stamp}.csv"`);
      return reply.type('text/csv; charset=utf-8').send(toCsv(days));
    }
    reply.header('Content-Disposition', `attachment; filename="ebbwell-${stamp}.json"`);
    return { app: 'ebbwell', version: EXPORT_VERSION, exportedAt: new Date().toISOString(), settings: store.getSettings(userId), days };
  });

  app.post('/api/import', { bodyLimit: 20 * 1024 * 1024 }, async (request, reply) => {
    const parsed = ImportSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', issues: parsed.error.issues.slice(0, 10) });
    const userId = uid(request);
    const { days, settings, mode } = parsed.data;
    store.tx(() => {
      if (mode === 'replace') store.deleteAllDays(userId);
      for (const d of days) if (!isEmptyDay(d.data)) store.putDay(userId, d.date, d.data);
      if (settings) store.saveSettings(userId, settings);
    });
    store.audit(userId, `import-${mode}`);
    return { imported: days.length };
  });

  app.get('/api/sessions', async (request) =>
    store.listSessions(uid(request)).map((s) => ({
      id: s.id.slice(0, 16),
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      userAgent: s.userAgent,
      current: s.id === request.sessionId,
    })),
  );

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const userId = uid(request);
    if (request.params.id === 'others') {
      store.deleteOtherSessions(userId, request.sessionId!);
    } else {
      const match = store.listSessions(userId).find((s) => s.id.slice(0, 16) === request.params.id);
      if (match) store.deleteSession(match.id, userId);
    }
    store.audit(userId, 'sessions-revoked');
    return reply.code(204).send();
  });

  app.get('/api/audit', async (request) => store.listAudit(uid(request)));

  /** Keeps the unlock window open while the user is active without other API calls. */
  app.post('/api/ping', async (_request, reply) => reply.code(204).send());

  registerLockRoutes(app, { config, store, sessions });
  registerAdminRoutes(app, { config, store, policy });
  registerPushRoutes(app, { store, publicKey: push.publicKey, send: push.send });
  registerSharingRoutes(app, { config, store });

  app.delete('/api/account', async (request, reply) => {
    const body = z.object({ confirm: z.literal('DELETE') }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'confirmation-required' });
    // The last administrator can't leave others without anyone to manage accounts.
    const me = request.user!;
    if (me.isAdmin && store.countActiveAdmins() <= 1 && store.listUsers().length > 1) {
      return reply.code(409).send({ error: 'last-admin' });
    }
    store.deleteUser(uid(request));
    sessions.destroy(request, reply);
    reply.header('Clear-Site-Data', '"cache", "cookies", "storage"');
    return { redirect: await endSessionUrl(app, config) };
  });

  // ---------------------------------------------------------------- static SPA
  const staticDir = resolve(config.STATIC_DIR);
  if (existsSync(staticDir)) {
    await app.register(fastifyStatic, {
      root: staticDir,
      index: false,
      wildcard: false, // Routes for the built files only (restart after rebuilding).
      setHeaders(res, path) {
        if (/[\\/]assets[\\/]/.test(path)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
        else res.header('Cache-Control', 'no-cache');
      },
    });
    app.setNotFoundHandler((request, reply) => {
      const isPage = request.method === 'GET' && !/^\/(api|auth)\//.test(request.url) && !/\.\w+$/.test(request.url.split('?')[0]!);
      if (isPage) return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
      return reply.code(404).send({ error: 'not-found' });
    });
  } else {
    app.log.warn(`Static directory ${staticDir} not found; serving API only`);
  }

  return app;
}

const CSV_COLUMNS = [
  'date', 'bleeding', 'bleeding_excluded', 'temperature_c', 'temperature_time', 'temperature_excluded', 'disturbances',
  'mucus_sensation', 'mucus_appearance', 'cervix_opening', 'cervix_firmness', 'cervix_position', 'lh', 'pregnancy_test',
  'sex', 'symptoms', 'mood', 'note',
] as const;

function toCsv(days: DayEntry[]): string {
  const cell = (v: unknown) => {
    if (v === undefined || v === null) return '';
    let s = String(v);
    // Neutralise spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = days.map(({ date, data: d }) =>
    [
      date, d.bleeding?.value, d.bleeding?.exclude, d.temperature?.value, d.temperature?.time, d.temperature?.exclude,
      d.temperature?.disturbances?.join('|'), d.mucus?.sensation, d.mucus?.appearance, d.cervix?.opening, d.cervix?.firmness,
      d.cervix?.position, d.lh, d.pregnancyTest, d.sex, d.symptoms?.join('|'), d.mood?.join('|'), d.note,
    ].map(cell).join(','),
  );
  return [CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}
