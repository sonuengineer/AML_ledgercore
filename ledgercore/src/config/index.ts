import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Rule: the process refuses to boot on invalid config. A bank's posting engine
 * must never start with, say, a 6-character JWT secret and discover it later.
 * Every other module imports the already-validated `config` object, so no
 * `process.env` access exists anywhere else in the codebase.
 */

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * Which instance this is. Set per container in compose / per task in ECS.
   *
   * It is an observability aid ONLY -- nothing behaves differently because of
   * it. The moment a request's CORRECTNESS depends on which node served it,
   * the API has stopped being stateless, which is the property Phase 8 exists
   * to prove.
   */
  INSTANCE_ID: z.string().default('local'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  DATABASE_URL: z.string().url(),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  // 32 bytes minimum for HS256. Shorter secrets are a real, exploitable weakness.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().min(1).default('ledgercore'),
  JWT_AUDIENCE: z.string().min(1).default('ledgercore-api'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // Absolute session ceiling. A rotated token never outlives the family's
  // original expiry, so this really is the maximum life of one login.
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 7),
  REFRESH_COOKIE_NAME: z.string().min(1).default('lc_rt'),
  // Set true only when the API is served over HTTPS. Left configurable because
  // a Secure cookie is simply not stored by the browser over plain http, which
  // would silently break local development.
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  REDIS_URL: z.string().default('redis://localhost:6379'),
  // Kill switch. Also how the Phase 6 before/after was measured: same build,
  // same data, one environment variable.
  CACHE_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  CACHE_DEFAULT_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // Deliberately tight. A slow cache must never become a slow API.
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(150),
  RATE_LIMIT_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

  QUEUE_REDIS_URL: z.string().default('redis://localhost:6380'),
  QUEUE_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(200),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(100).default(5),

  WORKER_METRICS_PORT: z.coerce.number().int().positive().default(9101),

  /**
   * Concurrency ceiling per node before load shedding begins.
   *
   * Phase 8 measured ~9 in-flight at 145 rps across three nodes with healthy
   * latency, and one node saturating CPU at ~175%. 200 is far above normal
   * and far below the point where the queue is unrecoverable -- a ceiling,
   * not a target.
   */
  MAX_IN_FLIGHT: z.coerce.number().int().positive().default(200),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** Server-side Postgres limits. Applied per connection -- see db/prisma.ts. */
  PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  PG_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  CORS_ORIGINS: z.string().default(''),
  BODY_LIMIT: z.string().default('256kb'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // No logger yet -- the logger itself depends on config. Plain stderr, then die.
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  process.stderr.write(`Invalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  env: env.NODE_ENV,
  instanceId: env.INSTANCE_ID,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',

  http: {
    port: env.PORT,
    bodyLimit: env.BODY_LIMIT,
    maxInFlight: env.MAX_IN_FLIGHT,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    corsOrigins: csv(env.CORS_ORIGINS),
  },

  log: {
    level: env.LOG_LEVEL,
  },

  db: {
    url: env.DATABASE_URL,
    statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
    pgStatementTimeoutMs: env.PG_STATEMENT_TIMEOUT_MS,
    pgLockTimeoutMs: env.PG_LOCK_TIMEOUT_MS,
  },

  auth: {
    jwtSecret: env.JWT_SECRET,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
    refreshCookieName: env.REFRESH_COOKIE_NAME,
    cookieSecure: env.COOKIE_SECURE,
    /**
     * The refresh cookie is scoped to the auth routes only. It is never sent
     * with an ordinary API call, so it cannot leak through a logging proxy on
     * a business endpoint and the CSRF surface is three routes instead of all.
     */
    refreshCookiePath: '/api/v1/auth',
  },

  cache: {
    url: env.REDIS_URL,
    enabled: env.CACHE_ENABLED,
    defaultTtlSeconds: env.CACHE_DEFAULT_TTL_SECONDS,
    commandTimeoutMs: env.REDIS_COMMAND_TIMEOUT_MS,
  },

  rateLimit: {
    enabled: env.RATE_LIMIT_ENABLED,
  },

  metrics: {
    workerPort: env.WORKER_METRICS_PORT,
  },

  queue: {
    url: env.QUEUE_REDIS_URL,
    enabled: env.QUEUE_ENABLED,
    outboxPollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    outboxBatchSize: env.OUTBOX_BATCH_SIZE,
    workerConcurrency: env.WORKER_CONCURRENCY,
  },

  shutdown: {
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  },
} as const;

export type Config = typeof config;
