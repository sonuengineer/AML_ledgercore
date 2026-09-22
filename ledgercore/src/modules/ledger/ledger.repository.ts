import { Prisma } from '@prisma/client';
import type { DrCr } from '@prisma/client';
import { prisma, type TxClient } from '../../shared/db/prisma';
import { money, type Money } from '../../shared/money/money';

/**
 * All SQL for the ledger.
 *
 * More raw SQL here than anywhere else in the codebase, and every instance is
 * deliberate. This is the split the Phase 2 ORM decision predicted: Prisma for
 * ordinary work, hand-written SQL exactly where row locking, set-based updates
 * and partition pruning live -- none of which Prisma can express.
 */

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export interface LockedBalance {
  accountId: string;
  accountNumber: string;
  accountStatus: string;
  freezeType: string;
  customerFreezeType: string | null;
  balanceSide: 'ASSET' | 'LIABILITY';
  productKind: string;
  allowCashDebit: boolean;
  allowCashCredit: boolean;
  allowTransferDebit: boolean;
  allowTransferCredit: boolean;
  ledgerBalance: string;
  clearedBalance: string;
  lienAmount: string;
  holdAmount: string;
  minimumBalance: string;
  overdraftLimit: string;
  version: number;
}

/**
 * Lock the balance rows for a set of accounts, and return everything the
 * posting decision needs in ONE query.
 *
 * Two things make this the most important function in the system.
 *
 * 1. `ORDER BY ab.account_id` inside the locking query.
 *
 *    Two simultaneous transfers between the same pair of accounts -- A->B and
 *    B->A -- will deadlock if each transaction locks in the order its own
 *    voucher happens to list. Transaction 1 holds A and wants B; transaction 2
 *    holds B and wants A. Postgres detects the cycle and kills one after
 *    `deadlock_timeout` (1s by default), so the user sees a slow, random
 *    failure.
 *
 *    Locking in a globally consistent order -- account id, ascending, always --
 *    means there is no cycle to form. One transaction simply waits. This is a
 *    one-line fix for a class of bug that is otherwise very hard to reproduce
 *    and very easy to ship.
 *
 * 2. One round trip, not N+1.
 *
 *    The naive version loads each account, then its balance, then its product,
 *    then its customer -- four queries per line, so twelve for a three-line
 *    voucher, each with its own lock acquisition. This joins them and takes
 *    every lock in one statement.
 *
 * `FOR UPDATE OF ab` locks ONLY the balance rows. Locking `account`, `product`
 * or `customer` too would serialise unrelated work -- every voucher touching
 * the same product would queue behind every other.
 */
export const lockBalancesForUpdate = async (
  accountIds: readonly string[],
  db: TxClient,
): Promise<LockedBalance[]> => {
  if (accountIds.length === 0) return [];

  return db.$queryRaw<LockedBalance[]>`
    SELECT a.id                    AS "accountId",
           a.account_number        AS "accountNumber",
           a.status::text          AS "accountStatus",
           a.freeze_type::text     AS "freezeType",
           c.freeze_type::text     AS "customerFreezeType",
           p.balance_side::text    AS "balanceSide",
           p.kind::text            AS "productKind",
           p.allow_cash_debit      AS "allowCashDebit",
           p.allow_cash_credit     AS "allowCashCredit",
           p.allow_transfer_debit  AS "allowTransferDebit",
           p.allow_transfer_credit AS "allowTransferCredit",
           ab.ledger_balance::text  AS "ledgerBalance",
           ab.cleared_balance::text AS "clearedBalance",
           ab.lien_amount::text     AS "lienAmount",
           ab.hold_amount::text     AS "holdAmount",
           p.minimum_balance::text  AS "minimumBalance",
           a.overdraft_limit::text  AS "overdraftLimit",
           ab.version               AS "version"
      FROM account_balance ab
      JOIN account  a ON a.id = ab.account_id
      JOIN product  p ON p.id = a.product_id
      LEFT JOIN customer c ON c.id = a.customer_id
     WHERE ab.account_id = ANY(${accountIds}::uuid[])
     ORDER BY ab.account_id
       FOR UPDATE OF ab
  `;
};

/**
 * Apply a signed delta to a balance, with an optimistic concurrency check.
 *
 * The row is already locked by `lockBalancesForUpdate`, so the version check is
 * belt and braces -- but it is the belt that catches a future code path which
 * forgets to lock. `rowsAffected = 0` then means someone else moved first, and
 * the caller retries rather than silently losing the write.
 *
 * `cleared_balance` moves with `ledger_balance` here because this system does
 * not yet model cheque clearing; when clearing arrives, a credit lands in
 * ledger only and cleared follows on the clearing run. The column split exists
 * now so that change is a service change, not a migration.
 */
export const applyBalanceDelta = async (
  accountId: string,
  delta: Money,
  expectedVersion: number,
  db: TxClient,
): Promise<number> =>
  db.$executeRaw`
    UPDATE account_balance
       SET ledger_balance  = ledger_balance  + ${delta}::numeric,
           cleared_balance = cleared_balance + ${delta}::numeric,
           last_posted_at  = now(),
           updated_at      = now(),
           version         = version + 1
     WHERE account_id = ${accountId}::uuid
       AND version    = ${expectedVersion}
  `;

/** Read-only available balance, straight from the view. Never used for posting. */
export interface AvailableBalanceRow {
  accountId: string;
  accountNumber: string;
  ledgerBalance: string;
  clearedBalance: string;
  uncleared: string;
  lienAmount: string;
  holdAmount: string;
  minimumBalance: string;
  overdraftLimit: string;
  availableBalance: string;
  version: number;
}

export const readAvailableBalance = async (
  accountId: string,
  db: TxClient = prisma,
): Promise<AvailableBalanceRow | null> => {
  const rows = await db.$queryRaw<AvailableBalanceRow[]>`
    SELECT account_id         AS "accountId",
           account_number     AS "accountNumber",
           ledger_balance::text   AS "ledgerBalance",
           cleared_balance::text  AS "clearedBalance",
           uncleared::text        AS "uncleared",
           lien_amount::text      AS "lienAmount",
           hold_amount::text      AS "holdAmount",
           minimum_balance::text  AS "minimumBalance",
           overdraft_limit::text  AS "overdraftLimit",
           available_balance::text AS "availableBalance",
           version
      FROM account_available_balance
     WHERE account_id = ${accountId}::uuid
  `;
  return rows[0] ?? null;
};

// ---------------------------------------------------------------------------
// Voucher numbering
// ---------------------------------------------------------------------------

/**
 * Next voucher number for a branch and business date.
 *
 * Uses a transaction-scoped advisory lock rather than a sequence, because the
 * number has to RESET each day and be gapless within the day -- auditors treat
 * a missing voucher number as a missing voucher. A Postgres sequence gives
 * neither: it never resets, and `nextval` is explicitly non-transactional, so
 * a rolled-back voucher burns its number permanently.
 *
 * The lock is scoped to (branch, date), so two branches never contend, and it
 * releases at COMMIT with no cleanup path to forget.
 */
export const nextVoucherNumber = async (
  branchId: string,
  branchCode: number,
  entryDate: Date,
  db: TxClient,
): Promise<string> => {
  const datePart = entryDate.toISOString().slice(0, 10);
  const prefix = `V${branchCode}-${datePart.replace(/-/g, '')}-`;

  /**
   * One row per (branch, date), incremented in place.
   *
   * This replaced a `MAX(SUBSTRING(...)) ... WHERE voucher_number LIKE 'p%'`
   * that scanned the ENTIRE voucher index on every posting -- 19.7ms at
   * 200,439 vouchers, growing forever, and executed while holding the lock
   * that serialises the posting path. See the migration for the EXPLAIN.
   *
   * `ON CONFLICT DO UPDATE` is atomic and takes a row lock on exactly this
   * (branch, date), which is the same mutual exclusion the previous
   * `pg_advisory_xact_lock` provided -- so that lock is gone, not merely
   * duplicated. Two branches still never contend.
   *
   * Gaplessness is preserved BECAUSE this runs inside the posting
   * transaction: a voucher that rolls back rolls its number back with it.
   * That is the property a Postgres sequence cannot give, since `nextval` is
   * non-transactional and a failed voucher would burn its number.
   *
   * It does NOT remove the serialisation. A gapless per-day counter is a
   * single point every posting in that branch must pass through, and the row
   * lock is held until COMMIT. What it removes is the growing WORK inside that
   * critical section. See PHASE15 for what it would take to remove the
   * serialisation itself.
   */
  const rows = await db.$queryRaw<Array<{ last_seq: number }>>`
    INSERT INTO voucher_sequence (branch_id, entry_date, last_seq)
    VALUES (${branchId}::uuid, ${datePart}::date, 1)
    ON CONFLICT (branch_id, entry_date)
    DO UPDATE SET last_seq = voucher_sequence.last_seq + 1
    RETURNING last_seq
  `;

  const seq = rows[0]?.last_seq ?? 1;
  return `${prefix}${String(seq).padStart(5, '0')}`;
};

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------

export const voucherInclude = {
  maker: { select: { id: true, displayName: true } },
  lines: {
    orderBy: { lineNumber: 'asc' },
    include: { account: { select: { accountNumber: true, title: true } } },
  },
  approvals: {
    orderBy: { level: 'asc' },
    include: { actor: { select: { displayName: true } } },
  },
} satisfies Prisma.VoucherInclude;

export type VoucherWithDetail = Prisma.VoucherGetPayload<{ include: typeof voucherInclude }>;

export const findVoucherById = async (
  id: string,
  db: TxClient = prisma,
): Promise<VoucherWithDetail | null> =>
  db.voucher.findUnique({ where: { id }, include: voucherInclude });

/**
 * Lock the voucher row before deciding on it.
 *
 * Without this, two checkers clicking Approve at the same moment can both read
 * `status = PENDING_AUTH`, both see the last required approval as theirs, and
 * both run the posting path -- applying the balance movements twice.
 */
export const lockVoucherForUpdate = async (
  id: string,
  db: TxClient,
): Promise<{ id: string; status: string; makerId: string; requiredApprovals: number; version: number } | null> => {
  const rows = await db.$queryRaw<
    Array<{ id: string; status: string; makerId: string; requiredApprovals: number; version: number }>
  >`
    SELECT id,
           status::text        AS status,
           maker_id            AS "makerId",
           required_approvals  AS "requiredApprovals",
           version
      FROM voucher
     WHERE id = ${id}::uuid
       FOR UPDATE
  `;
  return rows[0] ?? null;
};

export interface InsertVoucherLineInput {
  voucherId: string;
  postDate: Date;
  lineNumber: number;
  accountId: string;
  drCr: DrCr;
  amount: Money;
  valueDate: Date;
  narration?: string | undefined;
  balanceAfter?: Money | undefined;
}

export const insertVoucherLines = async (
  lines: readonly InsertVoucherLineInput[],
  db: TxClient,
): Promise<void> => {
  await db.voucherLine.createMany({
    data: lines.map((line) => ({
      voucherId: line.voucherId,
      postDate: line.postDate,
      lineNumber: line.lineNumber,
      accountId: line.accountId,
      drCr: line.drCr,
      amount: new Prisma.Decimal(line.amount),
      valueDate: line.valueDate,
      narration: line.narration ?? null,
      balanceAfter: line.balanceAfter ? new Prisma.Decimal(line.balanceAfter) : null,
    })),
  });
};

export const setLineBalanceAfter = async (
  voucherId: string,
  lineNumber: number,
  postDate: Date,
  balanceAfter: Money,
  db: TxClient,
): Promise<void> => {
  await db.$executeRaw`
    UPDATE voucher_line
       SET balance_after = ${balanceAfter}::numeric
     WHERE voucher_id = ${voucherId}::uuid
       AND line_number = ${lineNumber}
       AND post_date   = ${postDate}
  `;
};

/** Batch control totals, maintained incrementally so day-end need not re-sum. */
export const addToBatchTotals = async (
  batchId: string,
  amount: Money,
  db: TxClient,
): Promise<void> => {
  await db.$executeRaw`
    UPDATE batch
       SET debit_total   = debit_total  + ${amount}::numeric,
           credit_total  = credit_total + ${amount}::numeric,
           voucher_count = voucher_count + 1,
           version       = version + 1
     WHERE id = ${batchId}::uuid
  `;
};

// ---------------------------------------------------------------------------
// Statement -- the read-heavy path
// ---------------------------------------------------------------------------

export interface StatementRow {
  id: string;
  postDate: Date;
  valueDate: Date;
  voucherNumber: string;
  lineNumber: number;
  drCr: DrCr;
  amount: string;
  balanceAfter: string | null;
  narration: string | null;
}

/**
 * Account statement: one account, a date window, newest first, keyset paged.
 *
 * Three deliberate choices, each visible in the EXPLAIN:
 *
 *  1. `post_date BETWEEN` lets the planner prune partitions -- a query for one
 *     month touches one partition, not the whole ledger.
 *  2. The ORDER BY exactly matches `(account_id, post_date DESC, line_number)`,
 *     so the index is scanned in order and there is no Sort node.
 *  3. Keyset, not OFFSET. At page 500 an OFFSET query reads and discards
 *     50,000 rows; this one still seeks straight to its starting point.
 */
export const findStatementLines = async (
  params: {
    accountId: string;
    fromDate: Date;
    toDate: Date;
    limit: number;
    cursorPostDate?: Date;
    cursorLineNumber?: number;
  },
  db: TxClient = prisma,
): Promise<StatementRow[]> => {
  const { accountId, fromDate, toDate, limit, cursorPostDate, cursorLineNumber } = params;

  if (cursorPostDate && cursorLineNumber !== undefined) {
    return db.$queryRaw<StatementRow[]>`
      SELECT vl.id,
             vl.post_date      AS "postDate",
             vl.value_date     AS "valueDate",
             v.voucher_number  AS "voucherNumber",
             vl.line_number    AS "lineNumber",
             vl.dr_cr          AS "drCr",
             vl.amount::text   AS "amount",
             vl.balance_after::text AS "balanceAfter",
             COALESCE(vl.narration, v.narration) AS "narration"
        FROM voucher_line vl
        JOIN voucher v ON v.id = vl.voucher_id
       WHERE vl.account_id = ${accountId}::uuid
         AND vl.post_date BETWEEN ${fromDate} AND ${toDate}
         AND (vl.post_date, vl.line_number) < (${cursorPostDate}::date, ${cursorLineNumber}::int)
       ORDER BY vl.post_date DESC, vl.line_number DESC
       LIMIT ${limit + 1}
    `;
  }

  return db.$queryRaw<StatementRow[]>`
    SELECT vl.id,
           vl.post_date      AS "postDate",
           vl.value_date     AS "valueDate",
           v.voucher_number  AS "voucherNumber",
           vl.line_number    AS "lineNumber",
           vl.dr_cr          AS "drCr",
           vl.amount::text   AS "amount",
           vl.balance_after::text AS "balanceAfter",
           COALESCE(vl.narration, v.narration) AS "narration"
      FROM voucher_line vl
      JOIN voucher v ON v.id = vl.voucher_id
     WHERE vl.account_id = ${accountId}::uuid
       AND vl.post_date BETWEEN ${fromDate} AND ${toDate}
     ORDER BY vl.post_date DESC, vl.line_number DESC
     LIMIT ${limit + 1}
  `;
};

// ---------------------------------------------------------------------------
// Authorisation policy
// ---------------------------------------------------------------------------

/**
 * How many checkers an amount needs.
 *
 * Branch-specific slabs win over bank-wide ones, and type-specific over
 * type-agnostic -- hence the ORDER BY on `IS NULL`, which sorts non-null
 * (more specific) first.
 */
export const findRequiredApprovals = async (
  branchId: string,
  transactionType: string,
  amount: Money,
  db: TxClient = prisma,
): Promise<number> => {
  const rows = await db.$queryRaw<Array<{ requiredApprovals: number }>>`
    SELECT required_approvals AS "requiredApprovals"
      FROM authorization_policy
     WHERE (branch_id = ${branchId}::uuid OR branch_id IS NULL)
       AND (transaction_type = ${transactionType}::transaction_type OR transaction_type IS NULL)
       AND min_amount <= ${amount}::numeric
       AND (max_amount IS NULL OR max_amount > ${amount}::numeric)
     ORDER BY (branch_id IS NULL), (transaction_type IS NULL), min_amount DESC
     LIMIT 1
  `;
  // No slab configured is not "no approval needed". Failing closed is the only
  // safe default for an authorisation rule.
  return rows[0]?.requiredApprovals ?? 1;
};

export const countApprovals = async (voucherId: string, db: TxClient): Promise<number> =>
  db.authorizationStep.count({ where: { voucherId, decision: 'APPROVED' } });

export const toMoney = (value: Prisma.Decimal | string): Money => money(value.toString());
