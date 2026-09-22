import pino from 'pino';
import { config } from '../../config';
import { getContext } from './context';

/**
 * Structured logging.
 *
 * Phase 9 defines the full metrics story. What matters already in Phase 3:
 *
 *  - JSON in production so CloudWatch / Loki can index fields, pretty in dev.
 *  - Every line carries `requestId` automatically, pulled from
 *    AsyncLocalStorage by a mixin. No call site has to remember it.
 *  - Redaction is configured up front, not bolted on after an incident.
 *    The legacy system wrote `Username: X, Pwd: Y` to a file on every login.
 */

const redactPaths = [
  'password',
  '*.password',
  'currentPassword',
  'newPassword',
  'passwordHash',
  '*.passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'authorization',
];

export const logger = pino({
  level: config.log.level,
  redact: {
    paths: redactPaths,
    censor: '[redacted]',
  },
  base: {
    service: 'ledgercore-api',
    env: config.env,
    // With three nodes shipping to one log stream, "which node?" is the first
    // question asked about any anomaly.
    instance: config.instanceId,
  },
  // Pulled into every log line, including lines emitted deep inside services.
  mixin() {
    const ctx = getContext();
    if (!ctx) return {};
    return {
      requestId: ctx.requestId,
      userId: ctx.userId,
      branchId: ctx.branchId,
    };
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: config.isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,service,env',
        },
      },
});

export type Logger = typeof logger;

/** Child logger for a subsystem, e.g. `moduleLogger('ledger')`. */
export const moduleLogger = (name: string) => logger.child({ module: name });
