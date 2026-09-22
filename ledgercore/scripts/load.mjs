/**
 * Load generator.
 *
 * Used for the Phase 6 cache before/after, the Phase 8 one-node vs three-node
 * comparison, and to give the Phase 9 metrics something real to report.
 *
 *   node scripts/load.mjs <baseUrl> <label> <concurrency> <durationMs>
 *
 * Reports p50/p95/p99 rather than a mean, because a mean hides exactly the
 * tail that matters -- and reports which instance served each request, which
 * is how the round-robin and statelessness proofs were made.
 */

const BASE = process.argv[2] ?? 'http://localhost:8080';
const LABEL = process.argv[3] ?? 'run';
const CONCURRENCY = Number(process.argv[4] ?? 40);
const DURATION_MS = Number(process.argv[5] ?? 10_000);

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

const login = async () => {
  const response = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ staffCode: 'M001', password: 'ChangeMe#2026' }),
  });
  const body = await response.json();
  if (!body.ok) throw new Error(`login failed: ${JSON.stringify(body.error)}`);
  return body.data.accessToken;
};

const main = async () => {
  const token = await login();
  const headers = { Authorization: `Bearer ${token}` };

  const latencies = [];
  const byInstance = new Map();
  let errors = 0;
  const deadline = Date.now() + DURATION_MS;

  const worker = async () => {
    while (Date.now() < deadline) {
      const start = process.hrtime.bigint();
      try {
        const response = await fetch(`${BASE}/api/v1/auth/me`, { headers });
        await response.arrayBuffer();
        if (!response.ok) {
          errors += 1;
          continue;
        }
        const instance = response.headers.get('x-instance-id') ?? 'unknown';
        byInstance.set(instance, (byInstance.get(instance) ?? 0) + 1);
        latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
      } catch {
        errors += 1;
      }
    }
  };

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsedMs = Date.now() - startedAt;

  const sorted = [...latencies].sort((a, b) => a - b);

  console.log(
    JSON.stringify(
      {
        label: LABEL,
        concurrency: CONCURRENCY,
        durationMs: elapsedMs,
        requests: latencies.length,
        errors,
        rps: Math.round((latencies.length / elapsedMs) * 1000),
        latencyMs: {
          p50: +percentile(sorted, 50).toFixed(2),
          p95: +percentile(sorted, 95).toFixed(2),
          p99: +percentile(sorted, 99).toFixed(2),
          max: +sorted[sorted.length - 1].toFixed(2),
        },
        distribution: Object.fromEntries([...byInstance].sort()),
      },
      null,
      2,
    ),
  );
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
