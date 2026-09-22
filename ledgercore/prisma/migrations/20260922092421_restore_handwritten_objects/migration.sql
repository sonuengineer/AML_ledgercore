-- Restore hand-written database objects that Prisma's diff removed.
--
-- WHY THIS MIGRATION EXISTS
--
-- `prisma migrate diff` compares the database against the Prisma schema and
-- emits whatever is needed to make them match. Anything the schema cannot
-- express -- a GIN trigram index, a partial index, a trigger, a view,
-- partitioning -- looks to it like drift, and it generates a DROP.
--
-- That is exactly what happened. The Phase 5 `voucher_list_index` migration
-- silently contained:
--
--     DROP INDEX "account_title_trgm_idx";
--     DROP INDEX "customer_full_name_trgm_idx";
--
-- and nobody read the generated SQL before applying it. The Phase 5 EXPLAIN
-- demo then recreated one of them by hand, which masked the loss: the search
-- was measured against an index the migrations do not produce.
--
-- The lesson is not "do not hand-write DDL". It is that mixing Prisma-managed
-- schema with hand-written objects means EVERY generated migration must be
-- read for DROPs before it is applied, and that a test must assert the
-- hand-written objects still exist. Both are now in place -- see
-- tests/schema.int.test.ts.
--
-- Everything below is idempotent, so this can be re-run safely.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Infix name search. A btree cannot serve `ILIKE '%nair%'` -- there is nothing
-- to seek to. pg_trgm indexes three-character substrings, so it can.
CREATE INDEX IF NOT EXISTS customer_full_name_trgm_idx
  ON "customer" USING GIN (full_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS account_title_trgm_idx
  ON "account" USING GIN (title gin_trgm_ops);

-- Partial indexes. Re-asserted here so a database built from migrations alone
-- matches the one these were originally created on.
CREATE INDEX IF NOT EXISTS voucher_pending_queue_idx
  ON "voucher" (branch_id, created_at)
  WHERE status = 'PENDING_AUTH';

CREATE INDEX IF NOT EXISTS outbox_pending_idx
  ON "outbox_event" (available_at)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS account_frozen_idx
  ON "account" (branch_id)
  WHERE freeze_type <> 'NONE';

CREATE INDEX IF NOT EXISTS batch_open_idx
  ON "batch" (branch_id, code)
  WHERE status = 'OPEN';

-- Phase 7: the outbox relay's claim query. Partial, because SENT rows are
-- noise in it and there will eventually be millions of them.
CREATE INDEX IF NOT EXISTS outbox_claimable_idx
  ON "outbox_event" (available_at, id)
  WHERE status IN ('PENDING', 'FAILED');
