import { Prisma, type AmlRule } from '@prisma/client';
import { prisma } from '../shared/db/prisma';
import { moduleLogger } from '../shared/logging/logger';
import { cached } from '../shared/cache/cacheAside';
import { amlAlertsRaised } from '../shared/metrics/registry';
import { QUEUES } from '../shared/queue/types';
import { createConsumer } from './consumer';

const log = moduleLogger('aml-worker');

interface EventPayload {
  eventType: string;
  aggregateId: string;
  payload: {
    voucherId?: string;
    voucherNumber?: string;
    totalAmount?: string;
    branchId?: string;
    postDate?: string;
    accountIds?: string[];
  };
}

/**
 * AML rule evaluation -- the Direction-2 slice promised in Phase 1.
 *
 * A posting event arrives, the worker aggregates the customer's recent
 * activity over each active rule's rolling window, and raises an alert when a
 * threshold is crossed. Modelled on what Phase 0 found in FinAmlor:
 * TAmlRuleList -> TAmlRuleresult, and TAmlCtrparameter for the cash threshold.
 *
 * ---------------------------------------------------------------------------
 * Why the windowed aggregation is a SQL query, not a Redis sorted set
 * ---------------------------------------------------------------------------
 *
 * Phase 1 sketched Redis sorted sets keyed by customer with timestamp scores,
 * which is the textbook answer for rolling-window counters and genuinely the
 * right tool at high throughput.
 *
 * It is the wrong tool HERE, for a reason worth stating rather than following
 * the sketch:
 *
 *   An alert has to be explainable to a regulator. "Which transactions made up
 *   this total?" is the first question asked, and a sorted set of scores
 *   cannot answer it -- it holds sums, not evidence. The alert's `evidence`
 *   column needs the contributing voucher ids, and they come from the ledger.
 *
 *   Redis is also evictable and this instance is `allkeys-lru` (Phase 6). A
 *   counter that silently loses a week of history produces a FALSE NEGATIVE in
 *   a compliance system -- the worst possible failure, and an invisible one.
 *
 * Redis still earns its place here: the RULE SET is cached, because it is read
 * on every posting and changes a few times a year. Caching the rules is safe;
 * caching the evidence is not. That distinction is the whole point.
 *
 * ---------------------------------------------------------------------------
 * Idempotency
 * ---------------------------------------------------------------------------
 *
 * Delivery is at-least-once, so this worker WILL evaluate the same voucher
 * twice. `aml_alert.dedupe_key` is unique on (rule, version, customer,
 * window), so a duplicate evaluation hits a constraint instead of raising a
 * second alert. That is idempotency enforced by the database rather than by
 * hoping -- the same choice made for the ledger in Phase 5.
 */

const RULE_CACHE_TTL = 300;

/**
 * Active rules, cached -- WITH an explicit reviver.
 *
 * The reviver is not optional decoration. `threshold` is a Prisma Decimal, and
 * JSON has no Decimal, so on a cache HIT it came back as a string while the
 * type still said Decimal. `total.lessThan(rule.threshold)` tolerated that,
 * because decimal.js accepts a string -- so the comparison worked and the bug
 * stayed hidden. `rule.threshold.toFixed(2)`, three lines further on in the
 * branch that RAISES the alert, did not.
 *
 * So the failure only appeared when a rule actually fired, on a cache hit:
 * 2,116 dead-lettered AML evaluations, each retried five times, discovered
 * only because the DeadLettersUnattended alert was pending. AML screening had
 * effectively stopped and nothing else said so.
 */
const activeRules = async (): Promise<AmlRule[]> =>
  cached<AmlRule[]>(
    'aml:rules:active',
    async () => prisma.amlRule.findMany({ where: { isActive: true }, orderBy: { code: 'asc' } }),
    {
      ttlSeconds: RULE_CACHE_TTL,
      revive: (raw) =>
        (raw as AmlRule[]).map((rule) => ({
          ...rule,
          threshold: new Prisma.Decimal(rule.threshold as unknown as string),
          createdAt: new Date(rule.createdAt),
          updatedAt: new Date(rule.updatedAt),
        })),
    },
  );

interface WindowAggregate {
  total: string;
  txnCount: number;
  voucherIds: string[];
}

/**
 * Aggregate a customer's DEBIT activity over a window.
 *
 * Debits only: money leaving is the compliance concern. `transaction_type` is
 * a parameter so CASH_THRESHOLD looks only at cash while STRUCTURING looks at
 * everything.
 *
 * Bounded by `post_date` on BOTH sides of the join.
 *
 * The original version bounded only voucher_line. That table is range
 * partitioned and did prune correctly, which is why the comment claiming "a
 * 30-day window reads one partition, not the whole ledger" looked right. The
 * voucher table it joins to is not partitioned and had no date predicate, so
 * every AML job seq scanned all 200k vouchers.
 */
const aggregateWindow = async (
  customerId: string,
  fromDate: Date,
  toDate: Date,
  transactionType: string | null,
): Promise<WindowAggregate> => {
  const rows = await prisma.$queryRaw<Array<{ total: string; txnCount: bigint; voucherIds: string[] }>>`
    SELECT COALESCE(SUM(vl.amount), 0)::text              AS "total",
           COUNT(DISTINCT v.id)                            AS "txnCount",
           COALESCE(ARRAY_AGG(DISTINCT v.id::text) FILTER (WHERE v.id IS NOT NULL), '{}') AS "voucherIds"
      FROM voucher_line vl
      JOIN voucher v  ON v.id = vl.voucher_id
      JOIN account a  ON a.id = vl.account_id
     WHERE a.customer_id = ${customerId}::uuid
       AND vl.dr_cr = 'DEBIT'
       AND v.status = 'POSTED'
       AND vl.post_date BETWEEN ${fromDate} AND ${toDate}
       -- The SAME bound on the voucher side. Without it the join had no date
       -- predicate and Postgres seq scanned all 200k vouchers on every AML
       -- job -- see the voucher_posted_post_date_idx migration. A voucher's
       -- lines carry its post_date, so this narrows the join without changing
       -- which rows qualify.
       AND v.post_date BETWEEN ${fromDate} AND ${toDate}
       AND (${transactionType}::text IS NULL OR v.transaction_type::text = ${transactionType})
  `;

  const row = rows[0];
  return {
    total: row?.total ?? '0',
    txnCount: Number(row?.txnCount ?? 0),
    voucherIds: row?.voucherIds ?? [],
  };
};

const transactionTypeFor = (rule: AmlRule): string | null =>
  rule.kind === 'CASH_THRESHOLD' ? 'CASH' : null;

export const evaluateVoucher = async (params: {
  voucherId: string;
  branchId: string;
  postDate: Date;
  accountIds: string[];
  requestId?: string | undefined;
}): Promise<number> => {
  const rules = await activeRules();
  if (rules.length === 0) return 0;

  // A voucher touches accounts; rules are about CUSTOMERS. Internal GL
  // accounts have no customer and are skipped -- the bank's own cash head is
  // not a party to be monitored.
  const accounts = await prisma.account.findMany({
    where: { id: { in: params.accountIds }, customerId: { not: null } },
    select: { id: true, customerId: true },
  });

  const customerIds = [...new Set(accounts.map((a) => a.customerId!))];
  let raised = 0;

  for (const customerId of customerIds) {
    for (const rule of rules) {
      const windowTo = params.postDate;
      const windowFrom = new Date(windowTo);
      windowFrom.setUTCDate(windowFrom.getUTCDate() - rule.windowDays);

      const aggregate = await aggregateWindow(
        customerId,
        windowFrom,
        windowTo,
        transactionTypeFor(rule),
      );

      const total = new Prisma.Decimal(aggregate.total);
      if (total.lessThan(rule.threshold)) continue;
      if (rule.minCount !== null && aggregate.txnCount < rule.minCount) continue;

      // Window is part of the key, so the same rule can fire again next month
      // for genuinely new activity -- but not twice for the same window.
      const dedupeKey = [
        rule.code,
        `v${rule.version}`,
        customerId,
        windowFrom.toISOString().slice(0, 10),
        windowTo.toISOString().slice(0, 10),
      ].join(':');

      try {
        await prisma.amlAlert.create({
          data: {
            ruleId: rule.id,
            // Pinned, so the alert stays explainable after the rule changes.
            ruleVersion: rule.version,
            customerId,
            branchId: params.branchId,
            evidence: {
              ruleCode: rule.code,
              ruleKind: rule.kind,
              threshold: rule.threshold.toFixed(2),
              windowDays: rule.windowDays,
              observedTotal: total.toFixed(2),
              transactionCount: aggregate.txnCount,
              // The answer to "which transactions made up this total?" --
              // which is why this is a SQL aggregate and not a Redis counter.
              contributingVouchers: aggregate.voucherIds.slice(0, 200),
            } as Prisma.InputJsonValue,
            observedAmount: total,
            windowFrom,
            windowTo,
            dedupeKey,
            triggeredByVoucherId: params.voucherId,
            requestId: params.requestId ?? null,
          },
        });

        raised += 1;
        amlAlertsRaised.inc({ rule: rule.code });
        log.warn(
          { ruleCode: rule.code, customerId, observed: total.toFixed(2), threshold: rule.threshold.toFixed(2) },
          'AML alert raised',
        );
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          // Already alerted for this rule/customer/window. Exactly what the
          // unique constraint is for: a redelivered event is a no-op.
          log.debug({ dedupeKey }, 'alert already exists for this window, skipping');
          continue;
        }
        throw error;
      }
    }
  }

  return raised;
};

export const startAmlWorker = () =>
  createConsumer<EventPayload>({ queue: QUEUES.AML, concurrency: 3 }, async (data, job) => {
    if (data.eventType !== 'voucher.posted') return;

    const { voucherId, branchId, postDate, accountIds } = data.payload;
    if (!voucherId || !branchId || !postDate || !accountIds?.length) {
      log.warn({ aggregateId: data.aggregateId }, 'posting event missing fields needed for AML evaluation');
      return;
    }

    const raised = await evaluateVoucher({
      voucherId,
      branchId,
      postDate: new Date(postDate),
      accountIds,
      requestId: job.data.requestId,
    });

    if (raised > 0) log.info({ voucherId, raised }, 'AML evaluation raised alerts');
  });
