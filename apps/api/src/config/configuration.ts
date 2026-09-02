import type { Env } from './env.validation';

/**
 * Groups the flat environment into cohesive config namespaces, so services
 * inject `config.get('jwt')` rather than reaching for raw process.env keys.
 */
export const configuration = (env: Env) => ({
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  port: env.API_PORT,
  globalPrefix: env.API_GLOBAL_PREFIX,
  webOrigin: env.WEB_ORIGIN,
  corsOrigins: env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  database: { url: env.DATABASE_URL },
  redis: { url: env.REDIS_URL },

  jwt: {
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessTtl: env.JWT_ACCESS_TTL,
    refreshTtl: env.JWT_REFRESH_TTL,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  },

  encryption: {
    key: Buffer.from(env.ENCRYPTION_KEY, 'base64'),
    version: env.ENCRYPTION_KEY_VERSION,
  },

  oauth: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      callbackUrl: env.GOOGLE_CALLBACK_URL,
      enabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    },
    microsoft: {
      clientId: env.MICROSOFT_CLIENT_ID,
      clientSecret: env.MICROSOFT_CLIENT_SECRET,
      tenant: env.MICROSOFT_TENANT,
      callbackUrl: env.MICROSOFT_CALLBACK_URL,
      enabled: Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET),
    },
    apple: {
      clientId: env.APPLE_CLIENT_ID,
      teamId: env.APPLE_TEAM_ID,
      keyId: env.APPLE_KEY_ID,
      privateKey: env.APPLE_PRIVATE_KEY,
      callbackUrl: env.APPLE_CALLBACK_URL,
      enabled: Boolean(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID),
    },
  },

  mail: {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
    secure: env.SMTP_SECURE,
    from: env.MAIL_FROM,
  },

  totp: { issuer: env.TOTP_ISSUER },

  ai: { serviceUrl: env.AI_SERVICE_URL, serviceToken: env.AI_SERVICE_TOKEN },

  fx: {
    provider: env.FX_PROVIDER,
    appId: env.OPENEXCHANGERATES_APP_ID,
    baseCurrency: env.BASE_CURRENCY,
  },

  observability: {
    logLevel: env.LOG_LEVEL,
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    sentryDsn: env.SENTRY_DSN,
  },

  throttle: {
    ttl: env.THROTTLE_TTL,
    limit: env.THROTTLE_LIMIT,
    /**
     * Kept for compatibility with existing .env files. The auth routes set
     * their own limits with @Throttle (register 5/hour, sign-in 10/minute, and
     * so on) because those differ per route; a single global number could only
     * ever act as a ceiling on every other route, which is what it used to do
     * by accident. See the throttler configuration in app.module.ts.
     */
    authLimit: env.AUTH_THROTTLE_LIMIT,
  },
});

export type AppConfig = ReturnType<typeof configuration>;
