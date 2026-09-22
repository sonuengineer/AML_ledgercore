-- Voucher numbering: replace an O(total vouchers) scan with an O(1) counter.
--
-- WHAT WAS WRONG
--
-- nextVoucherNumber computed the next sequence with:
--
--   SELECT COALESCE(MAX(SUBSTRING(voucher_number FROM n)::int), 0) + 1
--     FROM voucher WHERE voucher_number LIKE 'V101-20260922-%'
--
-- A btree index CAN serve a prefix LIKE as a range scan, but only under the C
-- collation or with varchar_pattern_ops. This database has neither, so
-- Postgres scanned the whole unique index and filtered. Measured at 200,439
-- vouchers:
--
--   Parallel Index Only Scan using voucher_voucher_number_key
--     Filter: voucher_number ~~ 'V101-20260922-%'
--     Rows Removed by Filter: 66,813   (per worker, x3 = the entire table)
--   Execution Time: 19.699 ms
--
-- 19.7ms, growing linearly with every voucher the bank has EVER posted, and
-- executed while holding the lock that serialises the posting path. The system
-- got slower every day, and nothing in the code changed.
--
-- WHY A TABLE AND NOT A SEQUENCE
--
-- Unchanged from the original reasoning: the number must reset daily and be
-- gapless, because an auditor treats a missing voucher number as a missing
-- voucher. `nextval` is non-transactional, so a rolled-back voucher burns its
-- number permanently. An UPDATE ... RETURNING inside the posting transaction
-- rolls back with it, which is exactly the required behaviour.
--
-- The row lock this takes also replaces the pg_advisory_xact_lock: one
-- (branch, date) row is the same mutual exclusion, with one fewer moving part.
CREATE TABLE "voucher_sequence" (
  "branch_id"  UUID NOT NULL,
  "entry_date" DATE NOT NULL,
  "last_seq"   INTEGER NOT NULL,
  CONSTRAINT "voucher_sequence_pkey" PRIMARY KEY ("branch_id", "entry_date"),
  CONSTRAINT "voucher_sequence_last_seq_positive" CHECK ("last_seq" > 0)
);

-- Backfill from the numbers already issued. Without this, today's counter
-- would restart at 1 and every posting would collide with the UNIQUE
-- constraint on voucher_number -- a deploy that breaks the money path at the
-- first request.
--
-- The regex deliberately excludes anything not issued by this function (test
-- fixtures use BYPASS-<uuid>), so a malformed number cannot poison a counter.
INSERT INTO "voucher_sequence" ("branch_id", "entry_date", "last_seq")
SELECT v."branch_id",
       to_date(split_part(v."voucher_number", '-', 2), 'YYYYMMDD'),
       MAX(substring(v."voucher_number" from '[0-9]+$')::int)
  FROM "voucher" v
 WHERE v."voucher_number" ~ '^V[0-9]+-[0-9]{8}-[0-9]+$'
 GROUP BY 1, 2;
