import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const key32 = z
  .string()
  .transform((v) => Buffer.from(v, 'base64'))
  .refine((b) => b.length === 32, 'must be 32 random bytes, base64-encoded (openssl rand -base64 32)');

const csv = z
  .string()
  .default('')
  .transform((v) => v.split(',').map((g) => g.trim()).filter(Boolean));

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const MIN_PASSWORD_LENGTH = 10;

/** Loopback, RFC 1918, CGNAT-free private IPv4, IPv6 unique-local and link-local. */
export const DEFAULT_LOCAL_NETWORKS = '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,::1/128,fc00::/7,fe80::/10';

const EnvSchema = z
  .object({
    NODE_ENV: z.string().default('production'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    /** Public URL of the app, as seen by browsers (e.g. https://ebbwell.example.com). */
    APP_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
    DATA_DIR: z.string().default('/data'),
    STATIC_DIR: z.string().default('dist'),

    /** "oidc" is accepted for configurations written before local accounts existed. */
    AUTH_MODE: z
      .enum(['standard', 'oidc', 'dev'])
      .default('standard')
      .transform((v) => (v === 'oidc' ? 'standard' : v)),
    ALLOW_INSECURE_DEV_AUTH: bool.default(false),

    // ---- OpenID Connect (optional when local accounts are enabled)
    OIDC_ISSUER: z.url().optional(),
    OIDC_CLIENT_ID: z.string().min(1).optional(),
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    OIDC_SCOPES: z.string().default('openid profile'),
    /** Button label on the sign-in page, e.g. "Authentik". */
    OIDC_PROVIDER_NAME: z.string().max(40).default('single sign-on'),
    /** Comma-separated groups allowed to use the app (empty = any authenticated user). */
    OIDC_ALLOWED_GROUPS: csv,
    /** Comma-separated groups whose members are Ebbwell administrators (synced at each login). */
    OIDC_ADMIN_GROUPS: csv,
    /** Also end the identity-provider session on logout. */
    OIDC_LOGOUT_SSO: bool.default(true),
    /** Only for tests against a local mock provider. */
    OIDC_ALLOW_HTTP: bool.default(false),

    // ---- Local accounts (username + password)
    /**
     * Where local accounts may sign in:
     *  - disabled:      nowhere (OpenID Connect only)
     *  - local-network: only from LOCAL_NETWORKS, and never through the public HTTPS domain of APP_URL
     *  - everywhere:    from anywhere, including the public domain (not recommended)
     */
    LOCAL_LOGIN: z.enum(['disabled', 'local-network', 'everywhere']).default('disabled'),
    /** Two-factor authentication (TOTP) for local accounts: optional, or required for everyone. */
    LOCAL_2FA: z.enum(['optional', 'required']).default('optional'),
    /** Networks considered local (CIDR, comma-separated). */
    LOCAL_NETWORKS: z.string().default(DEFAULT_LOCAL_NETWORKS),
    /** Creates this local administrator at startup if no account with that username exists. */
    ADMIN_USERNAME: z.string().regex(USERNAME_RE, '3–32 lowercase letters, digits, dot, dash or underscore').optional(),
    ADMIN_PASSWORD: z.string().min(MIN_PASSWORD_LENGTH).max(128).optional(),

    DATA_ENCRYPTION_KEY: key32,
    DATA_ENCRYPTION_KEY_PREVIOUS: key32.optional(),

    SESSION_IDLE_DAYS: z.coerce.number().min(1).max(365).default(14),
    SESSION_MAX_DAYS: z.coerce.number().min(1).max(365).default(90),
    TRUST_PROXY: z.string().default('loopback,uniquelocal'),
    HSTS: bool.default(false),
    BACKUP_RETENTION_DAYS: z.coerce.number().int().min(0).max(365).default(14),
    /** Web Push keys; generated once and stored encrypted in the database when unset. */
    VAPID_PUBLIC_KEY: z.string().optional(),
    VAPID_PRIVATE_KEY: z.string().optional(),
    /** Contact for push services (mailto: or https:); defaults to APP_URL. */
    VAPID_SUBJECT: z.string().regex(/^(mailto:|https:\/\/)/, 'must start with mailto: or https://').optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((env, ctx) => {
    const oidcKeys = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] as const;
    if (oidcKeys.some((k) => env[k])) {
      for (const k of oidcKeys) {
        if (!env[k]) ctx.addIssue({ code: 'custom', path: [k], message: 'required when OpenID Connect is configured' });
      }
    }
    if (env.AUTH_MODE === 'standard' && !env.OIDC_ISSUER && env.LOCAL_LOGIN === 'disabled') {
      ctx.addIssue({
        code: 'custom',
        path: ['LOCAL_LOGIN'],
        message: 'no way to sign in: configure OpenID Connect (OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET) or enable LOCAL_LOGIN',
      });
    }
    if (!!env.ADMIN_USERNAME !== !!env.ADMIN_PASSWORD) {
      ctx.addIssue({ code: 'custom', path: ['ADMIN_PASSWORD'], message: 'ADMIN_USERNAME and ADMIN_PASSWORD go together' });
    }
    if (env.AUTH_MODE === 'dev' && !env.ALLOW_INSECURE_DEV_AUTH) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_MODE'], message: 'dev auth requires ALLOW_INSECURE_DEV_AUTH=true' });
    }
    if (env.SESSION_IDLE_DAYS > env.SESSION_MAX_DAYS) {
      ctx.addIssue({ code: 'custom', path: ['SESSION_IDLE_DAYS'], message: 'must be ≤ SESSION_MAX_DAYS' });
    }
  });

export type Config = z.infer<typeof EnvSchema>;

export const oidcEnabled = (config: Config) => config.AUTH_MODE === 'standard' && !!config.OIDC_ISSUER;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty variable means "not set" (the TrueNAS app form writes blank optional fields as "").
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
