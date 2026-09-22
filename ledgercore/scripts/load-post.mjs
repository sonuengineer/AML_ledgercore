/**
 * Write-path load generator.
 *
 * scripts/load.mjs drives GET /auth/me. That is the READ path, and it is the
 * path every earlier phase measured. For a ledger the interesting question is
 * the other one: how many postings per second, and what stops it.
 *
 *   node scripts/load-post.mjs <baseUrl> <accountsFile> <mode> <concurrency> <durationMs>
 *
 * MODES
 *
 *   spread  Each voucher debits one account and credits another, both drawn at
 *           random from the pool. Different requests touch different rows, so
 *           row locks rarely collide. This is the optimistic case.
 *
 *   hot     Each voucher debits a random account and credits ONE shared
 *           account -- a cash GL, a suspense account, a settlement account.
 *           Every concurrent posting therefore wants the same balance row.
 *
 * The gap between the two modes is the number that matters. A ledger does not
 * usually run out of CPU; it runs out of one row.
 *
 * Errors are reported BY CODE, not as a count. "500 errors" says nothing;
 * "1,400 CONCURRENCY_CONFLICT" and "3 INTERNAL_ERROR" are different worlds.
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE = process.argv[2] ?? 'http://localhost:8080';
const ACCOUNTS_FILE = process.argv[3];
const MODE = process.argv[4] ?? 'spread';
const CONCURRENCY = Number(process.argv[5] ?? 20);
const DURATION_MS = Number(process.argv[6] ?? 20_000);
const AMOUNT = process.env.POST_AMOUNT ?? '1.00';

const accounts = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
if (accounts.length < 2) throw new Error('need at least two accounts');

// The hot account is the FIRST in the pool, so `hot` and `spread` runs of the
// same pool are otherwise identical.
const HOT = accounts[0];

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

const login = async (staffCode) => {
  const response = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ staffCode, password: 'ChangeMe#2026' }),
  });
  const body = await response.json();
  if (!body.ok) throw new Error(`login ${staffCode} failed: ${JSON.stringify(body.error)}`);
  return body.data.accessToken;
};

const pickPair = () => {
  if (MODE === 'hot') {
    let debit = accounts[1 + Math.floor(Math.random() * (accounts.length - 1))];
    return [debit, HOT];
  }
  const i = Math.floor(Math.random() * accounts.length);
  let j = Math.floor(Math.random() * accounts.length);
  if (j === i) j = (j + 1) % accounts.length;
  return [accounts[i], accounts[j]];
};

const main = async () => {
  // Several operators, because the posting rate limit is per USER. One token
  // would measure the rate limiter rather than the ledger.
  // Branch 101 only, and only roles that actually hold `voucher:create`.
  // The first version included S001 (SYS_ADMIN, no voucher permissions) and
  // that one worker failed instantly in a tight loop -- 491 FORBIDDEN against
  // 45 real postings, which made the error rate read 92% and hid the fact
  // that the postings themselves were the slow part.
  // Overridable, because the per-branch scaling experiment needs operators
  // from a DIFFERENT branch -- a posting is made in the maker's branch.
  const staff = (process.env.POST_STAFF ?? 'M001,O001,T001,T002').split(',');
  const tokens = [];
  for (const code of staff) {
    try {
      tokens.push(await login(code));
    } catch {
      /* not every seeded user can post; skip */
    }
  }
  if (tokens.length === 0) throw new Error('no usable operator');

  const latencies = [];
  const errorsByCode = new Map();
  let ok = 0;
  const deadline = Date.now() + DURATION_MS;

  const worker = async (n) => {
    const token = tokens[n % tokens.length];
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    while (Date.now() < deadline) {
      const [debit, credit] = pickPair();
      const start = process.hrtime.bigint();
      try {
        const response = await fetch(`${BASE}/api/v1/vouchers`, {
          method: 'POST',
          headers: { ...headers, 'Idempotency-Key': randomUUID() },
          body: JSON.stringify({
            transactionType: 'TRANSFER',
            narration: `load ${MODE}`,
            lines: [
              { accountId: debit, drCr: 'DEBIT', amount: AMOUNT },
              { accountId: credit, drCr: 'CREDIT', amount: AMOUNT },
            ],
          }),
        });
        const body = await response.json().catch(() => null);
        if (response.ok && body?.ok) {
          ok += 1;
          latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
        } else {
          const code = body?.error?.code ?? `HTTP_${response.status}`;
          errorsByCode.set(code, (errorsByCode.get(code) ?? 0) + 1);
        }
      } catch (error) {
        const code = `CLIENT_${error.name}`;
        errorsByCode.set(code, (errorsByCode.get(code) ?? 0) + 1);
      }
    }
  };

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, n) => worker(n)));
  const elapsedMs = Date.now() - startedAt;

  const sorted = [...latencies].sort((a, b) => a - b);
  const attempted = ok + [...errorsByCode.values()].reduce((a, b) => a + b, 0);

  console.log(
    JSON.stringify(
      {
        mode: MODE,
        concurrency: CONCURRENCY,
        operators: tokens.length,
        durationMs: elapsedMs,
        attempted,
        posted: ok,
        postsPerSecond: Math.round((ok / elapsedMs) * 1000),
        errorRate: attempted ? +((1 - ok / attempted) * 100).toFixed(2) : 0,
        errorsByCode: Object.fromEntries([...errorsByCode].sort((a, b) => b[1] - a[1])),
        latencyMs: sorted.length
          ? {
              p50: +percentile(sorted, 50).toFixed(2),
              p95: +percentile(sorted, 95).toFixed(2),
              p99: +percentile(sorted, 99).toFixed(2),
              max: +sorted[sorted.length - 1].toFixed(2),
            }
          : null,
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
