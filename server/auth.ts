import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import type { Config } from './config.ts';
import { randomToken, sha256, type Cipher } from './crypto.ts';
import type { Store, User } from './db.ts';

export const SESSION_COOKIE = '__Host-lune_session';
const FLOW_COOKIE = '__Host-lune_flow';
const FLOW_TTL_MS = 10 * 60_000;
const TOUCH_INTERVAL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
    sessionId?: string;
  }
}

interface Flow {
  verifier: string;
  state: string;
  nonce: string;
  exp: number;
}

const cookieBase = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;

export class Sessions {
  private readonly store: Store;
  private readonly config: Config;

  constructor(store: Store, config: Config) {
    this.store = store;
    this.config = config;
  }

  create(reply: FastifyReply, user: User, userAgent: string) {
    const token = randomToken();
    const now = Date.now();
    const expiresAt = now + this.config.SESSION_MAX_DAYS * DAY_MS;
    this.store.createSession(sha256(token), user.id, userAgent, expiresAt);
    reply.setCookie(SESSION_COOKIE, token, { ...cookieBase, maxAge: this.config.SESSION_IDLE_DAYS * 86_400 });
  }

  /** Resolves the session cookie; refreshes the sliding idle window. */
  resolve(request: FastifyRequest, reply: FastifyReply): boolean {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return false;
    const id = sha256(token);
    const session = this.store.getSession(id);
    const now = Date.now();
    if (!session) return false;
    if (session.expiresAt < now || session.lastSeenAt + this.config.SESSION_IDLE_DAYS * DAY_MS < now) {
      this.store.deleteSession(id);
      return false;
    }
    const user = this.store.getUser(session.userId);
    if (!user) return false;
    if (now - session.lastSeenAt > TOUCH_INTERVAL_MS) {
      this.store.touchSession(id, now);
      const maxAge = Math.min(this.config.SESSION_IDLE_DAYS * DAY_MS, session.expiresAt - now) / 1000;
      reply.setCookie(SESSION_COOKIE, token, { ...cookieBase, maxAge: Math.floor(maxAge) });
    }
    request.user = user;
    request.sessionId = id;
    return true;
  }

  destroy(request: FastifyRequest, reply: FastifyReply) {
    if (request.sessionId) this.store.deleteSession(request.sessionId);
    reply.clearCookie(SESSION_COOKIE, cookieBase);
  }
}

function page(title: string, message: string, action = '<a href="/auth/login">Try again</a>') {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lune</title><link rel="stylesheet" href="/auth.css"></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p><p>${action}</p></main></body></html>`;
}

export async function registerAuth(app: FastifyInstance, deps: { config: Config; store: Store; cipher: Cipher; sessions: Sessions }) {
  const { config, store, cipher, sessions } = deps;
  const redirectUri = `${config.APP_URL}/auth/callback`;
  const authLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  if (config.AUTH_MODE === 'dev') {
    app.log.warn('AUTH_MODE=dev: anyone reaching this server is logged in as "Dev user". Never use this in production.');
    app.get('/auth/login', authLimit, async (request, reply) => {
      const user = store.upsertUser('dev-user', 'Dev user');
      sessions.create(reply, user, request.headers['user-agent'] ?? '');
      store.audit(user.id, 'login');
      return reply.redirect('/');
    });
  } else {
    // Discovery is lazy and retried, so the app starts even if Authentik is briefly down.
    let configPromise: Promise<oidc.Configuration> | null = null;
    const getConfig = () => {
      configPromise ??= oidc
        .discovery(
          new URL(config.OIDC_ISSUER!),
          config.OIDC_CLIENT_ID!,
          config.OIDC_CLIENT_SECRET!,
          undefined,
          config.OIDC_ALLOW_HTTP ? { execute: [oidc.allowInsecureRequests] } : undefined,
        )
        .catch((err) => {
          configPromise = null;
          throw err;
        });
      return configPromise;
    };
    app.decorate('oidcConfig', getConfig);

    app.get('/auth/login', authLimit, async (_request, reply) => {
      let oidcConfig: oidc.Configuration;
      try {
        oidcConfig = await getConfig();
      } catch (err) {
        app.log.error({ err }, 'OIDC discovery failed');
        return reply.code(503).type('text/html').send(page('Sign-in unavailable', 'The identity provider could not be reached.'));
      }
      const flow: Flow = {
        verifier: oidc.randomPKCECodeVerifier(),
        state: oidc.randomState(),
        nonce: oidc.randomNonce(),
        exp: Date.now() + FLOW_TTL_MS,
      };
      const url = oidc.buildAuthorizationUrl(oidcConfig, {
        redirect_uri: redirectUri,
        scope: config.OIDC_SCOPES,
        code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier),
        code_challenge_method: 'S256',
        state: flow.state,
        nonce: flow.nonce,
      });
      reply.setCookie(FLOW_COOKIE, cipher.encryptJson(flow, 'oidc-flow'), { ...cookieBase, maxAge: FLOW_TTL_MS / 1000 });
      return reply.redirect(url.href);
    });

    app.get('/auth/callback', authLimit, async (request, reply) => {
      const raw = request.cookies[FLOW_COOKIE];
      reply.clearCookie(FLOW_COOKIE, cookieBase);
      let flow: Flow | null = null;
      try {
        flow = raw ? cipher.decryptJson<Flow>(raw, 'oidc-flow') : null;
      } catch {
        flow = null;
      }
      if (!flow || flow.exp < Date.now()) {
        return reply.code(400).type('text/html').send(page('Sign-in expired', 'The sign-in attempt expired or was started elsewhere.'));
      }
      let claims: oidc.IDToken;
      try {
        const oidcConfig = await getConfig();
        const currentUrl = new URL(request.url, config.APP_URL);
        const tokens = await oidc.authorizationCodeGrant(oidcConfig, currentUrl, {
          pkceCodeVerifier: flow.verifier,
          expectedState: flow.state,
          expectedNonce: flow.nonce,
          idTokenExpected: true,
        });
        claims = tokens.claims()!;
      } catch (err) {
        request.log.warn({ err: (err as Error).message }, 'OIDC callback rejected');
        return reply.code(400).type('text/html').send(page('Sign-in failed', 'The identity provider response could not be verified.'));
      }

      if (config.OIDC_ALLOWED_GROUPS.length) {
        const groups = Array.isArray(claims.groups) ? (claims.groups as unknown[]).map(String) : [];
        if (!groups.some((g) => config.OIDC_ALLOWED_GROUPS.includes(g))) {
          store.audit(null, 'login-denied-group');
          return reply
            .code(403)
            .type('text/html')
            .send(page('Access denied', 'Your account is not allowed to use this app.', ''));
        }
      }

      const name = String(claims.name ?? claims.preferred_username ?? claims.given_name ?? 'You').slice(0, 100);
      const user = store.upsertUser(`${claims.iss}|${claims.sub}`, name);
      sessions.create(reply, user, request.headers['user-agent'] ?? '');
      store.audit(user.id, 'login');
      return reply.redirect('/');
    });
  }

  app.post('/auth/logout', authLimit, async (request, reply) => {
    sessions.resolve(request, reply);
    const userId = request.user?.id;
    sessions.destroy(request, reply);
    if (userId) store.audit(userId, 'logout');
    reply.header('Clear-Site-Data', '"cache", "cookies", "storage"');
    return { redirect: await endSessionUrl(app, config) };
  });
}

export async function endSessionUrl(app: FastifyInstance, config: Config): Promise<string> {
  if (config.AUTH_MODE !== 'oidc' || !config.OIDC_LOGOUT_SSO) return '/signed-out.html';
  try {
    const oidcConfig = await (app as unknown as { oidcConfig: () => Promise<oidc.Configuration> }).oidcConfig();
    if (!oidcConfig.serverMetadata().end_session_endpoint) return '/signed-out.html';
    return oidc.buildEndSessionUrl(oidcConfig, { client_id: config.OIDC_CLIENT_ID! }).href;
  } catch {
    return '/signed-out.html';
  }
}
