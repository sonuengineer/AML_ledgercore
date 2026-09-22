-- Make idempotency an ATOMIC CLAIM rather than a check-then-act race.
--
-- The row is now inserted BEFORE the work runs, so the unique constraint on
-- `key` is what serialises concurrent retries. A null response means the
-- request is still in flight.
--
-- Existing rows all completed, so they are backfilled as complete.
ALTER TABLE "idempotency_key" ALTER COLUMN "response_status" DROP NOT NULL;
ALTER TABLE "idempotency_key" ALTER COLUMN "response_body" DROP NOT NULL;
ALTER TABLE "idempotency_key" ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMPTZ(6);

UPDATE "idempotency_key" SET completed_at = created_at WHERE completed_at IS NULL;
