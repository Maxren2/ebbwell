import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import { z } from 'zod';
import type { AccessInfo, AccessPolicy } from './access.ts';
import { MIN_PASSWORD_LENGTH, oidcEnabled, type Config } from './config.ts';
import { randomToken, sha256, type Cipher } from './crypto.ts';
import type { AppLock, SessionRow, Store, User } from './db.ts';
import { dummyHash, hashSecret, verifySecret } from './passwords.ts';
import { checkSecondFactor, nextStep, twoFactorSetupRequired } from './twofactor.ts';
import { generateRecoveryCodes, generateSecret, hashRecoveryCode, otpauthUri, qrSvg, verifyTotp } from './totp.ts';
import { messages, textDirection, type Lang } from '../shared/i18n/index.ts';
import { requestLang } from './i18n.ts';

/** HTTPS: host-locked, Secure cookie. */
export const SESSION_COOKIE = '__Host-ebbwell_session';
/** Plain-HTTP access from the local network only (browsers refuse Secure cookies over http). */
export const SESSION_COOKIE_LAN = 'ebbwell_session';
const FLOW_COOKIE = '__Host-ebbwell_flow';
const FORM_COOKIE = '__Host-ebbwell_form';
const FORM_COOKIE_LAN = 'ebbwell_form';
/** Password accepted, second factor pending (encrypted, 5 minutes). */
const PENDING_COOKIE = '__Host-ebbwell_2fa';
const PENDING_COOKIE_LAN = 'ebbwell_2fa';
const PENDING_TTL_MS = 5 * 60_000;
/** Secret being enrolled (encrypted, 10 minutes). */
const SETUP_COOKIE = '__Host-ebbwell_2fa_setup';
const SETUP_COOKIE_LAN = 'ebbwell_2fa_setup';
const SETUP_TTL_MS = 10 * 60_000;
const FLOW_TTL_MS = 10 * 60_000;
const TOUCH_INTERVAL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
/** A fresh sign-in (password, or prompt=login at the provider) allows resetting a forgotten PIN for this long. */
const RESET_WINDOW_MS = 10 * 60_000;
/** Maximum age of auth_time for an identity-provider re-authentication to count as fresh. */
const FRESH_AUTH_SEC = 300;
export const MAX_LOGIN_FAILURES = 10;
export const LOGIN_LOCK_MS = 15 * 60_000;

/** How long an unlock lasts without activity. "Lock when I leave" (0) keeps a 5-minute backstop. */
export const lockWindowMs = (lock: AppLock) => (lock.timeoutSec > 0 ? lock.timeoutSec : 300) * 1000;

declare module 'fastify' {
  interface FastifyRequest {
    access: AccessInfo;
    user?: User;
    sessionId?: string;
    session?: SessionRow;
  }
}

interface Flow {
  verifier: string;
  state: string;
  nonce: string;
  exp: number;
  reauth: boolean;
}

const secureCookie = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;
const lanCookie = { httpOnly: true, secure: false, sameSite: 'lax', path: '/' } as const;
const cookieFor = (access: AccessInfo) => (access.secure ? { name: SESSION_COOKIE, opts: secureCookie } : { name: SESSION_COOKIE_LAN, opts: lanCookie });

/**
 * Local accounts may be used on this request: the policy allows it, and credentials never
 * travel over plain HTTP outside the local network.
 */
export const localAccountsAllowed = (access: AccessInfo) => access.localLoginAllowed && (access.secure || access.local);

export class Sessions {
  private readonly store: Store;
  private readonly config: Config;

  constructor(store: Store, config: Config) {
    this.store = store;
    this.config = config;
  }

  /**
   * New sessions of a user with an app lock start locked, unless the user just proved
   * their identity (password entered, or forced re-authentication at the provider),
   * which also allows a PIN reset.
   */
  create(request: FastifyRequest, reply: FastifyReply, user: User, fresh = false) {
    const token = randomToken();
    const now = Date.now();
    const expiresAt = now + this.config.SESSION_MAX_DAYS * DAY_MS;
    const lock = this.store.getLock(user.id);
    this.store.createSession(sha256(token), user.id, request.headers['user-agent'] ?? '', expiresAt, {
      unlockedUntil: lock && fresh ? now + lockWindowMs(lock) : 0,
      resetUntil: lock && fresh ? now + RESET_WINDOW_MS : 0,
    });
    const { name, opts } = cookieFor(request.access);
    reply.setCookie(name, token, { ...opts, maxAge: this.config.SESSION_IDLE_DAYS * 86_400 });
  }

  /** Resolves the session cookie; refreshes the sliding idle window. */
  resolve(request: FastifyRequest, reply: FastifyReply): boolean {
    const { name, opts } = cookieFor(request.access);
    const token = request.cookies[name];
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
    if (!user || user.disabled) return false;
    if (now - session.lastSeenAt > TOUCH_INTERVAL_MS) {
      this.store.touchSession(id, now);
      const maxAge = Math.min(this.config.SESSION_IDLE_DAYS * DAY_MS, session.expiresAt - now) / 1000;
      reply.setCookie(name, token, { ...opts, maxAge: Math.floor(maxAge) });
    }
    request.user = user;
    request.sessionId = id;
    request.session = session;
    return true;
  }

  destroy(request: FastifyRequest, reply: FastifyReply) {
    if (request.sessionId) this.store.deleteSession(request.sessionId);
    const { name, opts } = cookieFor(request.access);
    reply.clearCookie(name, opts);
  }
}

// ------------------------------------------------------------------ server-rendered pages

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function page(lang: Lang, title: string, body: string) {
  return `<!doctype html><html lang="${lang}" dir="${textDirection(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Ebbwell</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/auth.css"></head>
<body><main><img src="/icon-192.png" alt="" class="logo"><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

export function recoveryCodesPage(lang: Lang, codes: string[], next: string) {
  const t = messages(lang).auth;
  return page(
    lang,
    t.recoveryTitle,
    `<p>${esc(t.recoveryIntro)}</p>
<ol class="codes" dir="ltr">${codes.map((c) => `<li><code>${esc(c)}</code></li>`).join('')}</ol>
<p class="hint">${esc(t.recoveryHint)}</p>
<a class="button" href="${esc(next)}">${esc(t.recoveryContinue)}</a>`,
  );
}

const message = (lang: Lang, title: string, text: string, action?: string) =>
  page(lang, title, `<p>${esc(text)}</p><p>${action ?? `<a class="button" href="/auth/login">${esc(messages(lang).auth.tryAgain)}</a>`}</p>`);

export async function registerAuth(
  app: FastifyInstance,
  deps: { config: Config; store: Store; cipher: Cipher; sessions: Sessions; policy: AccessPolicy },
) {
  const { config, store, cipher, sessions } = deps;
  const redirectUri = `${config.APP_URL}/auth/callback`;
  const authLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const passwordLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  const useOidc = oidcEnabled(config);

  // HTML forms post application/x-www-form-urlencoded.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 4096 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  /** Double-submit token for the sign-in and password forms (login CSRF). */
  const formToken = (request: FastifyRequest, reply: FastifyReply) => {
    const token = randomToken(18);
    const secure = request.access.secure;
    reply.setCookie(secure ? FORM_COOKIE : FORM_COOKIE_LAN, token, { ...(secure ? secureCookie : lanCookie), maxAge: 1800 });
    return token;
  };
  const formTokenValid = (request: FastifyRequest, submitted: unknown) => {
    const expected = request.cookies[request.access.secure ? FORM_COOKIE : FORM_COOKIE_LAN];
    // Browsers send "Origin: null" on form posts under our no-referrer policy, so prefer
    // Sec-Fetch-Site; the double-submit token below is the actual protection.
    const site = request.headers['sec-fetch-site'];
    const origin = request.headers.origin;
    const sameOrigin = site
      ? site === 'same-origin'
      : !origin || origin === 'null' || origin === `${request.access.secure ? 'https' : 'http'}://${request.headers.host}`;
    return sameOrigin && typeof submitted === 'string' && !!expected && submitted === expected;
  };

  // ---------------------------------------------------------------- dev mode

  if (config.AUTH_MODE === 'dev') {
    app.log.warn('AUTH_MODE=dev: anyone reaching this server is logged in as "Dev user". Never use this in production.');
    app.get<{ Querystring: { reauth?: string } }>('/auth/login', authLimit, async (request, reply) => {
      const user = store.upsertUser('dev-user', 'Dev user', { isAdmin: true });
      sessions.create(request, reply, user, request.query.reauth === '1');
      store.audit(user.id, 'login');
      return reply.redirect('/');
    });
  }

  // ---------------------------------------------------------------- sign-in page

  if (config.AUTH_MODE === 'standard') {
    app.get<{ Querystring: { reauth?: string; error?: string } }>('/auth/login', authLimit, async (request, reply) => {
      const reauth = request.query.reauth === '1' ? '?reauth=1' : '';
      const lang = requestLang(request);
      const t = messages(lang).auth;
      reply.header('Cache-Control', 'no-store');
      if (!localAccountsAllowed(request.access)) {
        if (useOidc) return reply.redirect(`/auth/oidc${reauth}`);
        return reply.code(403).type('text/html').send(message(lang, t.unavailableTitle, t.networkNotAllowed, ''));
      }
      const error = t.loginErrors[request.query.error ?? ''];
      const token = formToken(request, reply);
      const sso = useOidc
        ? `<div class="or"><span>${esc(t.or)}</span></div><a class="button secondary" href="/auth/oidc${reauth}">${esc(t.signInWith(config.OIDC_PROVIDER_NAME))}</a>`
        : '';
      return reply.type('text/html').send(
        page(
          lang,
          t.signInTitle,
          `${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/auth/local">
  <input type="hidden" name="csrf" value="${token}">
  <label>${esc(t.username)}<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="32" dir="ltr"></label>
  <label>${esc(t.password)}<input name="password" type="password" autocomplete="current-password" required maxlength="128"></label>
  <button type="submit">${esc(t.signIn)}</button>
</form>${sso}`,
        ),
      );
    });

    // ---------------------------------------------------------------- local accounts

    app.post('/auth/local', passwordLimit, async (request, reply) => {
      if (!localAccountsAllowed(request.access)) {
        store.audit(null, 'login-local-refused-network');
        const lang = requestLang(request);
        return reply.code(403).type('text/html').send(message(lang, messages(lang).auth.unavailableTitle, messages(lang).auth.passwordNotAllowed, ''));
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (!formTokenValid(request, body.csrf)) return reply.redirect('/auth/login?error=expired', 303);
      const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';

      const creds = username ? store.findLocalCredentials(username) : null;
      if (!creds) {
        await verifySecret(password, await dummyHash()); // same timing as a real check
        return reply.redirect('/auth/login?error=invalid', 303);
      }
      if (creds.lockedUntil > Date.now()) return reply.redirect('/auth/login?error=locked', 303);
      if (!(await verifySecret(password, creds.passwordHash))) {
        const locked = store.recordLoginFailure(creds.user.id, MAX_LOGIN_FAILURES, LOGIN_LOCK_MS);
        store.audit(creds.user.id, locked ? 'login-locked' : 'login-failed');
        return reply.redirect(`/auth/login?error=${locked ? 'locked' : 'invalid'}`, 303);
      }
      if (creds.user.disabled) return reply.redirect('/auth/login?error=disabled', 303);

      if (creds.user.twoFactor) {
        const secure = request.access.secure;
        reply.setCookie(secure ? PENDING_COOKIE : PENDING_COOKIE_LAN, cipher.encryptJson({ uid: creds.user.id, exp: Date.now() + PENDING_TTL_MS }, '2fa-pending'), {
          ...(secure ? secureCookie : lanCookie),
          maxAge: PENDING_TTL_MS / 1000,
        });
        return reply.redirect('/auth/2fa', 303);
      }
      store.recordLogin(creds.user.id);
      // A password was just typed: the session starts unlocked and may reset a forgotten PIN.
      sessions.create(request, reply, creds.user, true);
      store.audit(creds.user.id, 'login-local');
      return reply.redirect(nextStep(config, creds.user), 303);
    });

    const passwordPage = (request: FastifyRequest, reply: FastifyReply, error?: string) => {
      const forced = request.user!.mustChangePassword;
      const token = formToken(request, reply);
      const lang = requestLang(request);
      const t = messages(lang).auth;
      return reply.type('text/html').send(
        page(
          lang,
          forced ? t.choosePasswordTitle : t.changePasswordTitle,
          `${forced ? `<p>${esc(t.temporaryIntro)}</p>` : ''}
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/auth/password">
  <input type="hidden" name="csrf" value="${token}">
  <input type="hidden" name="username" autocomplete="username" value="${esc(request.user!.username ?? '')}">
  ${forced ? '' : `<label>${esc(t.currentPassword)}<input name="current" type="password" autocomplete="current-password" required maxlength="128"></label>`}
  <label>${esc(t.newPassword(MIN_PASSWORD_LENGTH))}<input name="password" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}" maxlength="128"></label>
  <label>${esc(t.repeatPassword)}<input name="confirm" type="password" autocomplete="new-password" required maxlength="128"></label>
  <button type="submit">${esc(t.savePassword)}</button>
</form>`,
        ),
      );
    };

    app.get('/auth/password', authLimit, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!sessions.resolve(request, reply)) return reply.redirect('/auth/login');
      if (request.user!.kind !== 'local') return reply.redirect('/');
      return passwordPage(request, reply);
    });

    app.post('/auth/password', passwordLimit, async (request, reply) => {
      if (!sessions.resolve(request, reply)) return reply.redirect('/auth/login', 303);
      const user = request.user!;
      if (user.kind !== 'local' || !localAccountsAllowed(request.access)) return reply.redirect('/', 303);
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (!formTokenValid(request, body.csrf)) return passwordPage(request, reply, messages(requestLang(request)).auth.formExpired);
      const result = await changePassword(store, user, {
        current: user.mustChangePassword ? undefined : String(body.current ?? ''),
        password: String(body.password ?? ''),
        confirm: String(body.confirm ?? ''),
      });
      if (result !== 'ok') return passwordPage(request, reply, passwordErrorText(requestLang(request), result));
      store.deleteUserSessions(user.id, request.sessionId);
      store.audit(user.id, 'password-changed');
      return reply.redirect(nextStep(config, store.getUser(user.id)!), 303);
    });

    // ---------------------------------------------------------------- two-factor: sign-in prompt

    const pendingUser = (request: FastifyRequest) => {
      const raw = request.cookies[request.access.secure ? PENDING_COOKIE : PENDING_COOKIE_LAN];
      try {
        const p = raw ? cipher.decryptJson<{ uid: string; exp: number }>(raw, '2fa-pending') : null;
        const user = p && p.exp > Date.now() ? store.getUser(p.uid) : null;
        return user && user.kind === 'local' && user.twoFactor && !user.disabled ? user : null;
      } catch {
        return null;
      }
    };
    const clearPending = (request: FastifyRequest, reply: FastifyReply) =>
      reply.clearCookie(request.access.secure ? PENDING_COOKIE : PENDING_COOKIE_LAN, request.access.secure ? secureCookie : lanCookie);

    const codePage = (request: FastifyRequest, reply: FastifyReply, error?: string) => {
      const token = formToken(request, reply);
      const lang = requestLang(request);
      const t = messages(lang).auth;
      return reply.type('text/html').send(
        page(
          lang,
          t.twoFactorTitle,
          `<p>${esc(t.enterCode)}</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/auth/2fa">
  <input type="hidden" name="csrf" value="${token}">
  <label>${esc(t.code)}<input name="code" autocomplete="one-time-code" inputmode="numeric" autocapitalize="none" spellcheck="false" required maxlength="20" autofocus dir="ltr"></label>
  <button type="submit">${esc(t.verify)}</button>
</form>
<p class="hint">${esc(t.lostPhone)}</p>
<p><a href="/auth/login">${esc(t.startOver)}</a></p>`,
        ),
      );
    };

    app.get<{ Querystring: { error?: string } }>('/auth/2fa', authLimit, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!localAccountsAllowed(request.access) || !pendingUser(request)) return reply.redirect('/auth/login');
      return codePage(request, reply, messages(requestLang(request)).auth.codeErrors[request.query.error ?? '']);
    });

    app.post('/auth/2fa', passwordLimit, async (request, reply) => {
      if (!localAccountsAllowed(request.access)) return reply.redirect('/auth/login', 303);
      const user = pendingUser(request);
      if (!user) return reply.redirect('/auth/login?error=expired', 303);
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (!formTokenValid(request, body.csrf)) return reply.redirect('/auth/2fa?error=expired', 303);
      const creds = store.findLocalCredentials(user.username!);
      if (!creds || creds.lockedUntil > Date.now()) {
        clearPending(request, reply);
        return reply.redirect('/auth/login?error=locked', 303);
      }
      const used = checkSecondFactor(store, user.id, typeof body.code === 'string' ? body.code : '');
      if (!used) {
        const locked = store.recordLoginFailure(user.id, MAX_LOGIN_FAILURES, LOGIN_LOCK_MS);
        store.audit(user.id, locked ? 'login-locked' : '2fa-failed');
        if (locked) {
          clearPending(request, reply);
          return reply.redirect('/auth/login?error=locked', 303);
        }
        return reply.redirect('/auth/2fa?error=invalid', 303);
      }
      clearPending(request, reply);
      store.recordLogin(user.id);
      sessions.create(request, reply, user, true);
      store.audit(user.id, used === 'recovery' ? 'login-local-recovery-code' : 'login-local-2fa');
      return reply.redirect(nextStep(config, user), 303);
    });

    // ---------------------------------------------------------------- two-factor: enrolment

    const setupPage = async (request: FastifyRequest, reply: FastifyReply, secret: string, error?: string) => {
      const user = request.user!;
      const forced = twoFactorSetupRequired(config, user);
      const token = formToken(request, reply);
      const uri = otpauthUri(user.username ?? user.name, secret);
      const grouped = secret.match(/.{1,4}/g)!.join(' ');
      const lang = requestLang(request);
      const t = messages(lang).auth;
      return reply.type('text/html').send(
        page(
          lang,
          t.setupTitle,
          `${forced ? `<p>${esc(t.setupRequired)}</p>` : ''}
<p>${esc(t.scan)}</p>
<div class="qr">${await qrSvg(uri)}</div>
<p class="hint">${esc(t.cantScan)} <code dir="ltr">${esc(grouped)}</code></p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/auth/2fa/setup">
  <input type="hidden" name="csrf" value="${token}">
  <input type="hidden" name="username" autocomplete="username" value="${esc(user.username ?? '')}">
  ${forced ? '' : `<label>${esc(t.currentPassword)}<input name="password" type="password" autocomplete="current-password" required maxlength="128"></label>`}
  <label>${esc(t.codeFromApp)}<input name="code" autocomplete="one-time-code" inputmode="numeric" required maxlength="8" dir="ltr"></label>
  <button type="submit">${esc(t.turnOn)}</button>
</form>
${forced ? '' : `<p><a href="/settings">${esc(messages(lang).common.cancel)}</a></p>`}`,
        ),
      );
    };
    const setupCookie = (request: FastifyRequest) => (request.access.secure ? SETUP_COOKIE : SETUP_COOKIE_LAN);
    const readSetup = (request: FastifyRequest) => {
      const raw = request.cookies[setupCookie(request)];
      try {
        const v = raw ? cipher.decryptJson<{ uid: string; secret: string; exp: number }>(raw, '2fa-setup') : null;
        return v && v.exp > Date.now() && v.uid === request.user!.id ? v.secret : null;
      } catch {
        return null;
      }
    };

    app.get('/auth/2fa/setup', authLimit, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!sessions.resolve(request, reply)) return reply.redirect('/auth/login');
      const user = request.user!;
      if (user.kind !== 'local' || !localAccountsAllowed(request.access)) return reply.redirect('/');
      if (user.mustChangePassword) return reply.redirect('/auth/password');
      if (user.twoFactor) return reply.redirect('/settings');
      const secret = readSetup(request) ?? generateSecret();
      reply.setCookie(setupCookie(request), cipher.encryptJson({ uid: user.id, secret, exp: Date.now() + SETUP_TTL_MS }, '2fa-setup'), {
        ...(request.access.secure ? secureCookie : lanCookie),
        maxAge: SETUP_TTL_MS / 1000,
      });
      return setupPage(request, reply, secret);
    });

    app.post('/auth/2fa/setup', passwordLimit, async (request, reply) => {
      if (!sessions.resolve(request, reply)) return reply.redirect('/auth/login', 303);
      const user = request.user!;
      if (user.kind !== 'local' || !localAccountsAllowed(request.access) || user.twoFactor) return reply.redirect('/', 303);
      const secret = readSetup(request);
      if (!secret) return reply.redirect('/auth/2fa/setup', 303);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const t = messages(requestLang(request));
      if (!formTokenValid(request, body.csrf)) return setupPage(request, reply, secret, t.auth.formExpired);
      if (!twoFactorSetupRequired(config, user)) {
        const hash = store.getPasswordHash(user.id);
        if (!hash || !(await verifySecret(String(body.password ?? ''), hash))) return setupPage(request, reply, secret, t.passwordErrors['wrong-current']);
      }
      const step = verifyTotp(secret, String(body.code ?? ''), -1);
      if (step === null) return setupPage(request, reply, secret, t.auth.invalidSetupCode);

      const codes = generateRecoveryCodes();
      store.setTotp(user.id, { secret, lastStep: step, recovery: codes.map(hashRecoveryCode), enabledAt: Date.now() });
      reply.clearCookie(setupCookie(request), request.access.secure ? secureCookie : lanCookie);
      store.deleteUserSessions(user.id, request.sessionId);
      store.audit(user.id, '2fa-enabled');
      return reply.type('text/html').send(recoveryCodesPage(requestLang(request), codes, '/'));
    });
  }

  // ---------------------------------------------------------------- OpenID Connect

  if (useOidc) {
    // Discovery is lazy and retried, so the app starts even if the provider is briefly down.
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

    app.get<{ Querystring: { reauth?: string } }>('/auth/oidc', authLimit, async (request, reply) => {
      let oidcConfig: oidc.Configuration;
      try {
        oidcConfig = await getConfig();
      } catch (err) {
        app.log.error({ err }, 'OIDC discovery failed');
        const lang = requestLang(request);
        return reply.code(503).type('text/html').send(message(lang, messages(lang).auth.unavailableTitle, messages(lang).auth.providerUnreachable));
      }
      const flow: Flow = {
        verifier: oidc.randomPKCECodeVerifier(),
        state: oidc.randomState(),
        nonce: oidc.randomNonce(),
        exp: Date.now() + FLOW_TTL_MS,
        reauth: request.query.reauth === '1',
      };
      const url = oidc.buildAuthorizationUrl(oidcConfig, {
        redirect_uri: redirectUri,
        scope: config.OIDC_SCOPES,
        code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier),
        code_challenge_method: 'S256',
        state: flow.state,
        nonce: flow.nonce,
        // Re-authentication (forgotten PIN): force the identity provider to ask for credentials again.
        ...(flow.reauth ? { prompt: 'login', max_age: '0' } : {}),
      });
      reply.setCookie(FLOW_COOKIE, cipher.encryptJson(flow, 'oidc-flow'), { ...secureCookie, maxAge: FLOW_TTL_MS / 1000 });
      return reply.redirect(url.href);
    });

    app.get('/auth/callback', authLimit, async (request, reply) => {
      const raw = request.cookies[FLOW_COOKIE];
      reply.clearCookie(FLOW_COOKIE, secureCookie);
      const lang = requestLang(request);
      const t = messages(lang).auth;
      let flow: Flow | null = null;
      try {
        flow = raw ? cipher.decryptJson<Flow>(raw, 'oidc-flow') : null;
      } catch {
        flow = null;
      }
      if (!flow || flow.exp < Date.now()) {
        return reply.code(400).type('text/html').send(message(lang, t.expiredTitle, t.expiredBody));
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
        return reply.code(400).type('text/html').send(message(lang, t.failedTitle, t.failedBody));
      }

      const groups = Array.isArray(claims.groups) ? (claims.groups as unknown[]).map(String) : [];
      if (config.OIDC_ALLOWED_GROUPS.length && !groups.some((g) => config.OIDC_ALLOWED_GROUPS.includes(g))) {
        store.audit(null, 'login-denied-group');
        return reply.code(403).type('text/html').send(message(lang, t.deniedTitle, t.deniedBody, ''));
      }

      const name = String(claims.name ?? claims.preferred_username ?? claims.given_name ?? 'You').slice(0, 100);
      const isAdmin = config.OIDC_ADMIN_GROUPS.length ? groups.some((g) => config.OIDC_ADMIN_GROUPS.includes(g)) : undefined;
      const user = store.upsertUser(`${claims.iss}|${claims.sub}`, name, { isAdmin });
      if (user.disabled) {
        store.audit(user.id, 'login-denied-disabled');
        return reply.code(403).type('text/html').send(message(lang, t.disabledTitle, t.disabledBody, ''));
      }
      const authTime = typeof claims.auth_time === 'number' ? claims.auth_time : 0;
      const fresh = flow.reauth && Date.now() / 1000 - authTime <= FRESH_AUTH_SEC;
      sessions.create(request, reply, user, fresh);
      store.audit(user.id, fresh ? 'login-reauth' : 'login');
      return reply.redirect(fresh ? '/settings#lock' : '/');
    });
  }

  app.get('/signed-out.html', async (request, reply) => {
    const lang = requestLang(request);
    const t = messages(lang).auth;
    return reply
      .header('Cache-Control', 'no-cache')
      .type('text/html')
      .send(page(lang, t.signedOutTitle, `<p>${esc(t.signedOutBody)}</p><a class="button" href="/auth/login">${esc(t.signInAgain)}</a>`));
  });

  app.post('/auth/logout', authLimit, async (request, reply) => {
    sessions.resolve(request, reply);
    const userId = request.user?.id;
    const kind = request.user?.kind;
    sessions.destroy(request, reply);
    if (userId) store.audit(userId, 'logout');
    // No Clear-Site-Data: Chrome on Android holds the response until the cache and the service
    // worker are cleared, which can take long enough that signing out looked broken. The session
    // cookie is cleared above, API responses are never cached, and the service worker only holds
    // the app shell.
    return { redirect: kind === 'oidc' ? await endSessionUrl(app, config) : '/signed-out.html' };
  });
}

// ------------------------------------------------------------------ passwords

const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(128);

export type PasswordError = 'wrong-current' | 'length' | 'mismatch' | 'contains-username';

/** Shared by the password page and the settings API. */
export async function changePassword(
  store: Store,
  user: User,
  input: { current?: string; password: string; confirm: string },
): Promise<'ok' | PasswordError> {
  if (input.current !== undefined) {
    const hash = store.getPasswordHash(user.id);
    if (!hash || !(await verifySecret(input.current, hash))) return 'wrong-current';
  }
  if (!passwordSchema.safeParse(input.password).success) return 'length';
  if (input.password !== input.confirm) return 'mismatch';
  if (user.username && input.password.toLowerCase().includes(user.username)) return 'contains-username';
  store.setPassword(user.id, await hashSecret(input.password), false);
  return 'ok';
}

export function passwordErrorText(lang: Lang, error: PasswordError): string {
  const t = messages(lang).passwordErrors;
  return error === 'length' ? t.length(MIN_PASSWORD_LENGTH) : t[error];
}

export async function endSessionUrl(app: FastifyInstance, config: Config): Promise<string> {
  if (!oidcEnabled(config) || !config.OIDC_LOGOUT_SSO) return '/signed-out.html';
  try {
    const oidcConfig = await (app as unknown as { oidcConfig: () => Promise<oidc.Configuration> }).oidcConfig();
    if (!oidcConfig.serverMetadata().end_session_endpoint) return '/signed-out.html';
    return oidc.buildEndSessionUrl(oidcConfig, { client_id: config.OIDC_CLIENT_ID! }).href;
  } catch {
    return '/signed-out.html';
  }
}
