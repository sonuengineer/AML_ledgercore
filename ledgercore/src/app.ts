import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { config } from './config';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { requestLogger } from './middleware/requestLogger';
import { httpMetrics, metricsHandler } from './middleware/metrics';
import { loadShedding } from './middleware/loadShedding';
import { requestTimeout } from './middleware/timeout';
import { healthRouter } from './modules/health/health.routes';
import { v1Router } from './routes/v1';

/**
 * Composition root.
 *
 * `createApp` builds and returns the Express app but does NOT listen. That
 * separation is what makes the app testable without a port, and it is what
 * `server.ts` needs in order to own the lifecycle (start, drain, stop).
 *
 * Middleware order is load-bearing. Reading top to bottom:
 */
export const createApp = (): Express => {
  const app = express();

  // Behind an ALB in Phase 11. Without this, req.ip is the load balancer's
  // address, which would make per-IP rate limiting (Phase 6) rate-limit the
  // load balancer instead of the caller.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // 1. Request id + AsyncLocalStorage scope. FIRST, so everything after it --
  //    including a failure in body parsing -- is traceable.
  app.use(requestContext);

  // 1b. Load shedding, as early as possible.
  //
  //     Shedding is only useful if it costs almost nothing. Placing it after
  //     body parsing would mean reading and parsing the body of every request
  //     we are about to refuse -- doing the expensive part of the work anyway.
  app.use(loadShedding({ maxInFlight: config.http.maxInFlight }));

  // 1c. Request deadline. Last-resort bound on a handler that never finishes.
  app.use(requestTimeout(config.http.requestTimeoutMs));

  // 2. Security headers before anything can respond.
  app.use(helmet());

  // 3. CORS. An explicit allowlist, never a reflected origin.
  app.use(
    cors({
      origin: config.http.corsOrigins.length > 0 ? config.http.corsOrigins : false,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Idempotency-Key'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    }),
  );

  // 4. Body parsing, with a hard size cap. An uncapped JSON body is a trivial
  //    memory-exhaustion vector on a single-threaded runtime.
  app.use(express.json({ limit: config.http.bodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: config.http.bodyLimit }));

  // 5. Cookies. The refresh token arrives as an httpOnly cookie scoped to
  //    /api/v1/auth; nothing else in this system reads a cookie.
  app.use(cookieParser());

  // 6. Access log. After parsing so it can report content-length, before the
  //    routes so it observes every one of them.
  app.use(requestLogger);

  // 6b. Metrics. Must be AFTER the router has had a chance to set req.route,
  //     but the observation happens on 'finish', so registering it here is
  //     correct -- by the time the callback runs, routing has happened and the
  //     templated route label is available.
  app.use(httpMetrics);

  // 6c. Scrape endpoint. Unauthenticated by design -- Prometheus has no
  //     credentials -- and safe to be so because no label carries content.
  //     Network-restricted in Phase 11.
  app.get('/metrics', metricsHandler);

  // 7. Health endpoints, deliberately unauthenticated and unversioned. The
  //    load balancer and the orchestrator have no credentials.
  app.use(healthRouter);

  // 8. The API.
  app.use('/api/v1', v1Router);

  // 9. Unmatched route -> 404 through the same envelope as every other error.
  app.use(notFoundHandler);

  // 10. The single error exit. Must be last, and must be 4-arity.
  app.use(errorHandler);

  return app;
};
