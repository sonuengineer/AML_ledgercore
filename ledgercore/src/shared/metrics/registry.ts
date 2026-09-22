import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { config } from '../../config';

/**
 * Metrics.
 *
 * Phase 3 gave every request a structured log line. Logs answer "what happened
 * to THIS request". They do not answer "is the system healthy right now", and
 * grepping a log stream for percentiles at 3am is not a monitoring strategy.
 *
 * ---------------------------------------------------------------------------
 * Histogram, not Summary
 * ---------------------------------------------------------------------------
 *
 * prom-client offers both. Summary computes quantiles IN THE PROCESS, which
 * means a p99 from api-1 and a p99 from api-2 cannot be combined -- averaging
 * percentiles is meaningless. With three nodes (Phase 8) that makes summaries
 * useless for exactly the question being asked.
 *
 * A histogram ships bucket COUNTS, which are additive. Prometheus sums them
 * across instances and computes the quantile over the whole fleet with
 * `histogram_quantile`. The cost is that the answer is bucket-resolution
 * rather than exact -- which is why the bucket boundaries below are chosen
 * around the latencies this system actually produces, not left at the default.
 *
 * ---------------------------------------------------------------------------
 * Cardinality
 * ---------------------------------------------------------------------------
 *
 * Every distinct label combination is a separate time series held in memory,
 * on every node, forever. A `userId` label on an HTTP metric would create one
 * series per user; a raw URL label would create one per account id. That is
 * the classic way to take down a Prometheus server with a one-line change.
 *
 * So: labels are bounded sets only -- method, TEMPLATED route, status class.
 * The unbounded detail (user, account, request id) stays in logs, where one
 * line costs bytes rather than a permanent series.
 */

export const registry = new Registry();

registry.setDefaultLabels({
  service: 'ledgercore',
  instance: config.instanceId,
});

/**
 * Node's own metrics: CPU, resident memory, heap, GC pauses, handles, and --
 * the important one -- event loop lag.
 *
 * Event loop lag is THE Node-specific health signal. A blocked event loop does
 * not raise CPU to 100% and does not show up as a slow query; every request
 * simply waits. It is the metric that distinguishes "the database is slow"
 * from "we are doing something CPU-bound on the request path", which are two
 * very different incidents with the same symptom.
 */
collectDefaultMetrics({
  register: registry,
  // Deliberately coarse: percentiles of GC duration are not actionable, the
  // presence of long pauses is.
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
});

// ---------------------------------------------------------------------------
// HTTP -- the RED method: Rate, Errors, Duration
// ---------------------------------------------------------------------------

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_class'] as const,
  /**
   * Buckets tuned to the measurements from Phases 6 and 8, not left at
   * prom-client's defaults.
   *
   * Phase 6 measured cached reads at ~10ms and uncached at ~27ms; Phase 8
   * measured p99 between 390ms and 2.1s under load. Default buckets
   * (0.005 .. 10) put almost everything into one or two buckets in the range
   * that matters, which makes the p95 a straight line and useless.
   */
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/**
 * In-flight requests.
 *
 * Rising in-flight with flat RPS is the signature of a dependency slowing
 * down: the same work arriving, taking longer, piling up. It leads the latency
 * percentiles, so it is an early warning rather than a post-mortem.
 */
export const httpRequestsInFlight = new Gauge({
  name: 'http_requests_in_flight',
  help: 'Requests currently being served',
  registers: [registry],
});

/**
 * Errors by CODE, not by message.
 *
 * The error codes from Phase 3 are a bounded set, which makes them safe as a
 * label. Messages are not -- they interpolate account numbers and amounts.
 */
export const httpErrors = new Counter({
  name: 'http_errors_total',
  help: 'HTTP errors by application error code',
  labelNames: ['code', 'status'] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query duration in seconds',
  // model+operation is bounded by the schema. Never the SQL text, which would
  // be unbounded and would leak parameters into metric labels.
  labelNames: ['model', 'operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5],
  registers: [registry],
});

export const dbPingDuration = new Histogram({
  name: 'db_ping_duration_seconds',
  help: 'SELECT 1 round trip, the floor on database latency',
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.05, 0.1, 1],
  registers: [registry],
});

export const cacheOperations = new Counter({
  name: 'cache_operations_total',
  help: 'Cache operations by result',
  labelNames: ['result'] as const, // hit | miss | error
  registers: [registry],
});

export const cachePingDuration = new Histogram({
  name: 'cache_ping_duration_seconds',
  help: 'Redis PING round trip',
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.05, 0.1, 1],
  registers: [registry],
});

export const cacheAvailable = new Gauge({
  name: 'cache_available',
  help: '1 when the cache is connected, 0 when degraded to the database',
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Async pipeline
// ---------------------------------------------------------------------------

/**
 * Queue depth. The autoscaling signal from Phase 7, and the one that says
 * "consumers cannot keep up" before any user notices -- the API is still
 * happily accepting work.
 */
export const queueDepth = new Gauge({
  name: 'queue_depth',
  help: 'Jobs in a queue by state',
  labelNames: ['queue', 'state'] as const,
  registers: [registry],
});

/**
 * Oldest unsent outbox event, in seconds.
 *
 * The single most important gauge in the system, for a non-obvious reason:
 * if the relay STOPS, the queue is EMPTY and every queue-depth dashboard goes
 * green while events pile up in Postgres. Queue depth cannot detect a stopped
 * producer. This can, and it is the only thing that can.
 */
export const outboxOldestPendingSeconds = new Gauge({
  name: 'outbox_oldest_pending_seconds',
  help: 'Age of the oldest unpublished outbox event',
  registers: [registry],
});

export const outboxEventsPublished = new Counter({
  name: 'outbox_events_published_total',
  help: 'Outbox events published by the relay',
  labelNames: ['result'] as const, // published | failed
  registers: [registry],
});

export const jobsProcessed = new Counter({
  name: 'jobs_processed_total',
  help: 'Queue jobs processed',
  labelNames: ['queue', 'job', 'result'] as const, // completed | retried | dead_lettered
  registers: [registry],
});

export const jobDuration = new Histogram({
  name: 'job_duration_seconds',
  help: 'Queue job processing duration',
  labelNames: ['queue', 'job'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60],
  registers: [registry],
});

export const deadLetters = new Gauge({
  name: 'dead_letters_unreplayed',
  help: 'Dead letters awaiting operator action',
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Business metrics
// ---------------------------------------------------------------------------

/**
 * Business metrics, because a technically healthy system that has stopped
 * doing business is still an incident.
 *
 * "Postings dropped to zero at 10:04" is a better alert than any of the
 * infrastructure metrics above -- it fires for causes nobody predicted, which
 * is exactly the class of incident the predicted alerts miss.
 */
export const vouchersPosted = new Counter({
  name: 'vouchers_posted_total',
  help: 'Vouchers posted',
  labelNames: ['transaction_type'] as const,
  registers: [registry],
});

export const vouchersRejected = new Counter({
  name: 'vouchers_rejected_total',
  help: 'Voucher attempts rejected by a business rule',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const pendingAuthorisations = new Gauge({
  name: 'vouchers_pending_authorisation',
  help: 'Vouchers waiting for a checker',
  registers: [registry],
});

export const authFailures = new Counter({
  name: 'auth_failures_total',
  help: 'Authentication failures by reason',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const amlAlertsRaised = new Counter({
  name: 'aml_alerts_raised_total',
  help: 'AML alerts raised',
  labelNames: ['rule'] as const,
  registers: [registry],
});

export const metricsSnapshot = async (): Promise<string> => registry.metrics();
