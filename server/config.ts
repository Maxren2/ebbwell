import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const key32 = z
  .string()
  .transform((v) => Buffer.from(v, 'base64'))
  .refine((b) => b.length === 32, 'must be 32 random bytes, base64-encoded (openssl rand -base64 32)');

const EnvSchema = z
  .object({
    NODE_ENV: z.string().default('production'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    /** Public URL of the app, as seen by browsers (e.g. https://ebbwell.example.com). */
    APP_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
    DATA_DIR: z.string().default('/data'),
    STATIC_DIR: z.string().default('dist'),

    AUTH_MODE: z.enum(['oidc', 'dev']).default('oidc'),
    ALLOW_INSECURE_DEV_AUTH: bool.default(false),
    OIDC_ISSUER: z.url().optional(),
    OIDC_CLIENT_ID: z.string().min(1).optional(),
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    OIDC_SCOPES: z.string().default('openid profile'),
    /** Comma-separated Authentik groups allowed to use the app (empty = any authenticated user). */
    OIDC_ALLOWED_GROUPS: z
      .string()
      .default('')
      .transform((v) => v.split(',').map((g) => g.trim()).filter(Boolean)),
    /** Also end the Authentik session on logout. */
    OIDC_LOGOUT_SSO: bool.default(true),
    /** Only for tests against a local mock provider. */
    OIDC_ALLOW_HTTP: bool.default(false),

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
    if (env.AUTH_MODE === 'oidc') {
      for (const k of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] as const) {
        if (!env[k]) ctx.addIssue({ code: 'custom', path: [k], message: 'required when AUTH_MODE=oidc' });
      }
    }
    if (env.AUTH_MODE === 'dev' && !env.ALLOW_INSECURE_DEV_AUTH) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_MODE'], message: 'dev auth requires ALLOW_INSECURE_DEV_AUTH=true' });
    }
    if (env.SESSION_IDLE_DAYS > env.SESSION_MAX_DAYS) {
      ctx.addIssue({ code: 'custom', path: ['SESSION_IDLE_DAYS'], message: 'must be ≤ SESSION_MAX_DAYS' });
    }
  });

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
