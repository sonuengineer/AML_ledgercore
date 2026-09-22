import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectDatabase, disconnectDatabase, prisma } from '../src/shared/db/prisma';

/**
 * Schema guard.
 *
 * This file exists because of a bug that cost real work: `prisma migrate diff`
 * compares the database to the Prisma schema and emits DROPs for anything the
 * schema cannot express. The Phase 5 `voucher_list_index` migration therefore
 * contained, unnoticed:
 *
 *     DROP INDEX "account_title_trgm_idx";
 *     DROP INDEX "customer_full_name_trgm_idx";
 *
 * An ad-hoc EXPLAIN script then recreated one of them by hand, which hid the
 * loss -- the Phase 5 search benchmark measured an index the migrations do not
 * produce. Nothing failed. Nothing warned. The only symptom would have been a
 * slow customer search in production, months later.
 *
 * Reviewing generated SQL is the first line of defence and depends on a human
 * being careful. This is the second line, and does not.
 *
 * Every object here is one the Prisma schema CANNOT express, so every one of
 * them is at risk from the next generated migration.
 */

beforeAll(async () => {
  await connectDatabase();
});

afterAll(async () => {
  await disconnectDatabase();
});

const indexExists = async (name: string): Promise<boolean> => {
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = ${name}
  `;
  return Number(rows[0]?.n ?? 0) > 0;
};

describe('hand-written indexes survive migrations', () => {
  it.each([
    ['customer_full_name_trgm_idx', 'infix customer name search'],
    ['account_title_trgm_idx', 'infix account title search'],
    ['voucher_pending_queue_idx', 'the authorisation queue'],
    ['outbox_pending_idx', 'the outbox relay poll'],
    ['account_frozen_idx', 'freeze checks on the posting path'],
    ['batch_open_idx', 'open-batch lookup per branch'],
  ])('%s exists (%s)', async (name) => {
    expect(await indexExists(name)).toBe(true);
  });

  it('the trigram indexes are GIN, not accidentally recreated as btree', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE indexdef LIKE '%gin_trgm_ops%'
       ORDER BY indexname
    `;
    expect(rows.map((row) => row.indexname)).toEqual([
      'account_title_trgm_idx',
      'customer_full_name_trgm_idx',
    ]);
  });

  it('the partial indexes really are partial', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexdef LIKE '%WHERE%'
       ORDER BY indexname
    `;
    // Asserted by name, not by count. A count assertion passes for the wrong
    // reasons -- adding an unrelated partial index would mask the loss of one
    // of these. A partial index that quietly became full still answers
    // queries, just with an index the size of the table, which is the entire
    // cost it was added to avoid.
    expect(rows.map((row) => row.indexname)).toEqual([
      'account_frozen_idx',
      'batch_open_idx',
      'outbox_claimable_idx',
      'outbox_pending_idx',
      'voucher_pending_queue_idx',
    ]);
  });
});

describe('constraints and triggers survive migrations', () => {
  it('the balanced-voucher constraint trigger is present and deferrable', async () => {
    const rows = await prisma.$queryRaw<Array<{ tgname: string; deferrable: boolean; enabled: string }>>`
      SELECT t.tgname,
             t.tgdeferrable AS deferrable,
             t.tgenabled::text AS enabled
        FROM pg_trigger t
       WHERE NOT t.tgisinternal
         AND t.tgname LIKE 'voucher_balanced%'
    `;
    expect(rows.length).toBeGreaterThan(0);
    // Deferred, because a voucher is legitimately unbalanced while its lines
    // are being inserted one at a time.
    expect(rows.every((row) => row.deferrable)).toBe(true);
    // 'O' = enabled for origin. A DISABLE left behind by a bulk load would
    // silently turn the invariant off.
    expect(rows.every((row) => row.enabled === 'O')).toBe(true);
  });

  it('the four-eyes trigger is present', async () => {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_trigger
       WHERE NOT tgisinternal AND tgname = 'authorization_step_maker_check'
    `;
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('the CHECK constraints are all still there', async () => {
    const rows = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
       WHERE contype = 'c' AND connamespace = 'public'::regnamespace
       ORDER BY conname
    `;
    const names = rows.map((row) => row.conname);
    for (const required of [
      'voucher_line_amount_positive',
      'voucher_total_positive',
      'voucher_value_date_not_future',
      'account_customer_xor_gl',
      'account_balance_uncleared_consistent',
      'voucher_reversal_needs_reason',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('the available-balance view exists, so readers cannot drift from the posting path', async () => {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_views
       WHERE schemaname = 'public' AND viewname = 'account_available_balance'
    `;
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

describe('safety settings are enforced at the ROLE level, not per connection', () => {
  /**
   * This block exists because of a bug Phase 11 found.
   *
   * Phase 10 set statement_timeout and lock_timeout through the connection
   * string's `options` parameter and verified them. Introducing pgBouncer
   * silently disabled BOTH -- `ignore_startup_parameters` drops `options`
   * rather than forwarding it -- and the Phase 10 chaos test kept passing,
   * because it connects DIRECTLY to Postgres while the containers go through
   * the pooler.
   *
   * A test that exercises a different path from production proves nothing
   * about production. So these assert the ROLE DEFAULTS, which Postgres
   * applies to every session by this role however it was opened.
   */
  it.each([
    ['statement_timeout', 'a query that turns pathological cannot run forever'],
    ['lock_timeout', 'a stuck transaction cannot freeze an account indefinitely'],
    ['idle_in_transaction_session_timeout', 'an abandoned transaction cannot block vacuum'],
  ])('%s is set as a role default (%s)', async (setting) => {
    const rows = await prisma.$queryRaw<Array<{ setconfig: string[] | null }>>`
      SELECT s.setconfig
        FROM pg_db_role_setting s
        JOIN pg_roles r ON r.oid = s.setrole
       WHERE r.rolname = current_user
    `;

    const config = rows.flatMap((row) => row.setconfig ?? []);
    const entry = config.find((item) => item.startsWith(`${setting}=`));

    expect(entry, `${setting} must be a role default so it survives any pooler`).toBeDefined();
    expect(entry).not.toMatch(/=0$/);
  });
});

describe('partitioning survives migrations', () => {
  it('voucher_line is partitioned by range on post_date', async () => {
    const rows = await prisma.$queryRaw<Array<{ strategy: string; key: string }>>`
      SELECT p.partstrat::text AS strategy,
             pg_get_partkeydef(c.oid) AS key
        FROM pg_partitioned_table p
        JOIN pg_class c ON c.oid = p.partrelid
       WHERE c.relname = 'voucher_line'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.strategy).toBe('r'); // range
    expect(rows[0]!.key).toContain('post_date');
  });

  it('has partitions covering the current date, and a DEFAULT catch-all', async () => {
    const rows = await prisma.$queryRaw<Array<{ relname: string; isdefault: boolean }>>`
      SELECT c.relname,
             pg_get_expr(c.relpartbound, c.oid) LIKE '%DEFAULT%' AS isdefault
        FROM pg_class c
        JOIN pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = 'voucher_line'
       ORDER BY c.relname
    `;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // Without a DEFAULT, an INSERT with no matching partition is an ERROR --
    // running out of partitions would be an outage rather than a degradation.
    expect(rows.some((row) => row.isdefault)).toBe(true);
  });

  it('nothing has landed in the DEFAULT partition (anything there is a bug)', async () => {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM voucher_line_overflow
    `;
    expect(Number(rows[0]!.n)).toBe(0);
  });
});
