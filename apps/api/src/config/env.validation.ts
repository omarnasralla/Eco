import { z } from 'zod';

/**
 * The process refuses to boot on a bad environment.
 *
 * A finance API that starts with a placeholder JWT secret and only reveals the
 * problem when someone forges a token is far worse than one that fails loudly
 * at deploy time. Every check here is a production incident we would rather not
 * have.
 */
const nonDefault = (placeholder: string) => (v: string) => !v.startsWith(placeholder.slice(0, 10));

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    TZ: z.string().default('UTC'),

    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    API_GLOBAL_PREFIX: z.string().default('api/v1'),
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    WEB_ORIGIN: z.string().url().default('http://localhost:3000'),

    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),

    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters')
      .refine(nonDefault('replace_me'), 'JWT_ACCESS_SECRET is still the placeholder value'),
    JWT_REFRESH_SECRET: z
      .string()
      .min(32, 'JWT_REFRESH_SECRET must be at least 32 characters')
      .refine(nonDefault('replace_me'), 'JWT_REFRESH_SECRET is still the placeholder value'),
    JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
    JWT_REFRESH_TTL: z.coerce.number().int().positive().default(2_592_000),
    JWT_ISSUER: z.string().default('eco.app'),
    JWT_AUDIENCE: z.string().default('eco.clients'),

    ENCRYPTION_KEY: z
      .string()
      .refine((v) => {
        try {
          return Buffer.from(v, 'base64').length === 32;
        } catch {
          return false;
        }
      }, 'ENCRYPTION_KEY must be exactly 32 bytes, base64-encoded (openssl rand -base64 32)')
      .refine(nonDefault('replace_me'), 'ENCRYPTION_KEY is still the placeholder value'),
    ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),

    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CALLBACK_URL: z.string().optional(),
    MICROSOFT_CLIENT_ID: z.string().optional(),
    MICROSOFT_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_TENANT: z.string().default('common'),
    MICROSOFT_CALLBACK_URL: z.string().optional(),
    APPLE_CLIENT_ID: z.string().optional(),
    APPLE_TEAM_ID: z.string().optional(),
    APPLE_KEY_ID: z.string().optional(),
    APPLE_PRIVATE_KEY: z.string().optional(),
    APPLE_CALLBACK_URL: z.string().optional(),

    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().default(1025),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_SECURE: z.coerce.boolean().default(false),
    MAIL_FROM: z.string().default('Eco <no-reply@eco.app>'),

    TOTP_ISSUER: z.string().default('Eco'),

    AI_SERVICE_URL: z.string().url().default('http://localhost:8000'),
    AI_SERVICE_TOKEN: z.string().default('replace_me_shared_service_token'),

    FX_PROVIDER: z.enum(['ecb', 'openexchangerates', 'fixed']).default('ecb'),
    OPENEXCHANGERATES_APP_ID: z.string().optional(),
    BASE_CURRENCY: z.string().length(3).default('USD'),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
    SENTRY_DSN: z.string().optional(),

    THROTTLE_TTL: z.coerce.number().int().positive().default(60),
    THROTTLE_LIMIT: z.coerce.number().int().positive().default(120),
    AUTH_THROTTLE_LIMIT: z.coerce.number().int().positive().default(10),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;

    // Production-only invariants. Development is allowed to be convenient.
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message:
          'Access and refresh secrets must differ, or a leaked access token can be replayed as a refresh token.',
      });
    }
    if (env.AI_SERVICE_TOKEN.startsWith('replace_me')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AI_SERVICE_TOKEN'],
        message: 'AI_SERVICE_TOKEN must be set to a real shared secret in production.',
      });
    }
    if (!env.DATABASE_URL.includes('sslmode=')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL must specify sslmode (require or verify-full) in production.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const details = parsed.error.issues
    .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${details}\n`);
}
