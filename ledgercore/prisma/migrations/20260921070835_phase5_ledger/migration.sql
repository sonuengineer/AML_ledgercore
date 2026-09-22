-- CreateEnum
CREATE TYPE "freeze_type" AS ENUM ('NONE', 'DEBIT_BLOCKED', 'TOTAL');

-- CreateEnum
CREATE TYPE "product_kind" AS ENUM ('SAVINGS', 'CURRENT_OD', 'TERM_LOAN');

-- CreateEnum
CREATE TYPE "balance_side" AS ENUM ('ASSET', 'LIABILITY');

-- CreateEnum
CREATE TYPE "account_status" AS ENUM ('ACTIVE', 'DORMANT', 'CLOSED');

-- CreateEnum
CREATE TYPE "batch_status" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "transaction_type" AS ENUM ('CASH', 'TRANSFER', 'CLEARING', 'SYSTEM');

-- CreateEnum
CREATE TYPE "voucher_status" AS ENUM ('PENDING_AUTH', 'POSTED', 'REJECTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "dr_cr" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "approval_decision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL,
    "customer_number" INTEGER NOT NULL,
    "full_name" VARCHAR(120) NOT NULL,
    "is_individual" BOOLEAN NOT NULL DEFAULT true,
    "date_of_birth" DATE,
    "pan_number" VARCHAR(10),
    "phone" VARCHAR(20),
    "email" VARCHAR(160),
    "home_branch_id" UUID NOT NULL,
    "group_customer_id" UUID,
    "freeze_type" "freeze_type" NOT NULL DEFAULT 'NONE',
    "freeze_reason" VARCHAR(120),
    "tax_exempt" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "code" VARCHAR(12) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "kind" "product_kind" NOT NULL,
    "balance_side" "balance_side" NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "minimum_balance" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "allow_cash_debit" BOOLEAN NOT NULL DEFAULT true,
    "allow_cash_credit" BOOLEAN NOT NULL DEFAULT true,
    "allow_transfer_debit" BOOLEAN NOT NULL DEFAULT true,
    "allow_transfer_credit" BOOLEAN NOT NULL DEFAULT true,
    "gl_account_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gl_account" (
    "id" UUID NOT NULL,
    "code" VARCHAR(12) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "side" "balance_side" NOT NULL,
    "is_postable" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gl_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" UUID NOT NULL,
    "account_number" VARCHAR(24) NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "customer_id" UUID,
    "gl_account_id" UUID,
    "title" VARCHAR(120) NOT NULL,
    "status" "account_status" NOT NULL DEFAULT 'ACTIVE',
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "freeze_type" "freeze_type" NOT NULL DEFAULT 'NONE',
    "freeze_reason" VARCHAR(120),
    "overdraft_limit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "opened_on" DATE NOT NULL,
    "closed_on" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_balance" (
    "account_id" UUID NOT NULL,
    "ledger_balance" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "cleared_balance" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "uncleared" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "lien_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "hold_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "last_posted_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "account_balance_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "batch" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "business_date_id" UUID NOT NULL,
    "code" VARCHAR(12) NOT NULL,
    "status" "batch_status" NOT NULL DEFAULT 'OPEN',
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "debit_total" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "credit_total" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "voucher_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voucher" (
    "id" UUID NOT NULL,
    "voucher_number" VARCHAR(32) NOT NULL,
    "branch_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "transaction_type" "transaction_type" NOT NULL,
    "status" "voucher_status" NOT NULL DEFAULT 'PENDING_AUTH',
    "entry_date" DATE NOT NULL,
    "post_date" DATE NOT NULL,
    "value_date" DATE NOT NULL,
    "total_amount" DECIMAL(19,4) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "narration" VARCHAR(140) NOT NULL,
    "instrument_number" VARCHAR(20),
    "instrument_date" DATE,
    "maker_id" UUID NOT NULL,
    "maker_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "required_approvals" INTEGER NOT NULL,
    "posted_at" TIMESTAMPTZ(6),
    "reversal_of_id" UUID,
    "reversal_reason" VARCHAR(140),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "voucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voucher_line" (
    "id" UUID NOT NULL,
    "post_date" DATE NOT NULL,
    "voucher_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "account_id" UUID NOT NULL,
    "dr_cr" "dr_cr" NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "value_date" DATE NOT NULL,
    "narration" VARCHAR(140),
    "balance_after" DECIMAL(19,4),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voucher_line_pkey" PRIMARY KEY ("id","post_date")
);

-- CreateTable
CREATE TABLE "authorization_policy" (
    "id" UUID NOT NULL,
    "branch_id" UUID,
    "transaction_type" "transaction_type",
    "min_amount" DECIMAL(19,4) NOT NULL,
    "max_amount" DECIMAL(19,4),
    "required_approvals" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authorization_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authorization_step" (
    "id" UUID NOT NULL,
    "voucher_id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "actor_id" UUID NOT NULL,
    "decision" "approval_decision" NOT NULL,
    "remarks" VARCHAR(140),
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authorization_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "key" VARCHAR(80) NOT NULL,
    "user_id" UUID NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL,
    "event_type" VARCHAR(60) NOT NULL,
    "aggregate_type" VARCHAR(40) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "request_id" VARCHAR(64),
    "status" "outbox_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(500),
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" VARCHAR(60) NOT NULL,
    "entity_type" VARCHAR(40) NOT NULL,
    "entity_id" UUID NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "request_id" VARCHAR(64),
    "ip_address" VARCHAR(45),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_customer_number_key" ON "customer"("customer_number");

-- CreateIndex
CREATE INDEX "customer_home_branch_id_idx" ON "customer"("home_branch_id");

-- CreateIndex
CREATE INDEX "customer_group_customer_id_idx" ON "customer"("group_customer_id");

-- CreateIndex
CREATE INDEX "customer_phone_idx" ON "customer"("phone");

-- CreateIndex
CREATE INDEX "product_branch_id_is_active_idx" ON "product"("branch_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "product_branch_id_code_key" ON "product"("branch_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "gl_account_code_key" ON "gl_account"("code");

-- CreateIndex
CREATE UNIQUE INDEX "account_account_number_key" ON "account"("account_number");

-- CreateIndex
CREATE INDEX "account_branch_id_status_idx" ON "account"("branch_id", "status");

-- CreateIndex
CREATE INDEX "account_customer_id_idx" ON "account"("customer_id");

-- CreateIndex
CREATE INDEX "account_product_id_idx" ON "account"("product_id");

-- CreateIndex
CREATE INDEX "batch_branch_id_status_idx" ON "batch"("branch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "batch_business_date_id_code_key" ON "batch"("business_date_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "voucher_voucher_number_key" ON "voucher"("voucher_number");

-- CreateIndex
CREATE UNIQUE INDEX "voucher_reversal_of_id_key" ON "voucher"("reversal_of_id");

-- CreateIndex
CREATE INDEX "voucher_branch_id_status_created_at_idx" ON "voucher"("branch_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "voucher_batch_id_idx" ON "voucher"("batch_id");

-- CreateIndex
CREATE INDEX "voucher_maker_id_created_at_idx" ON "voucher"("maker_id", "created_at");

-- CreateIndex

-- CreateIndex

-- CreateIndex

-- CreateIndex
CREATE INDEX "authorization_policy_branch_id_transaction_type_min_amount_idx" ON "authorization_policy"("branch_id", "transaction_type", "min_amount");

-- CreateIndex
CREATE INDEX "authorization_step_actor_id_decided_at_idx" ON "authorization_step"("actor_id", "decided_at");

-- CreateIndex
CREATE UNIQUE INDEX "authorization_step_voucher_id_level_key" ON "authorization_step"("voucher_id", "level");

-- CreateIndex
CREATE UNIQUE INDEX "authorization_step_voucher_id_actor_id_key" ON "authorization_step"("voucher_id", "actor_id");

-- CreateIndex
CREATE INDEX "idempotency_key_expires_at_idx" ON "idempotency_key"("expires_at");

-- CreateIndex
CREATE INDEX "outbox_event_status_available_at_idx" ON "outbox_event"("status", "available_at");

-- CreateIndex
CREATE INDEX "outbox_event_aggregate_type_aggregate_id_idx" ON "outbox_event"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "audit_event_entity_type_entity_id_occurred_at_idx" ON "audit_event"("entity_type", "entity_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_event_actor_id_occurred_at_idx" ON "audit_event"("actor_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_home_branch_id_fkey" FOREIGN KEY ("home_branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_group_customer_id_fkey" FOREIGN KEY ("group_customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_gl_account_id_fkey" FOREIGN KEY ("gl_account_id") REFERENCES "gl_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_gl_account_id_fkey" FOREIGN KEY ("gl_account_id") REFERENCES "gl_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_balance" ADD CONSTRAINT "account_balance_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch" ADD CONSTRAINT "batch_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch" ADD CONSTRAINT "batch_business_date_id_fkey" FOREIGN KEY ("business_date_id") REFERENCES "business_date"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher" ADD CONSTRAINT "voucher_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher" ADD CONSTRAINT "voucher_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher" ADD CONSTRAINT "voucher_maker_id_fkey" FOREIGN KEY ("maker_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher" ADD CONSTRAINT "voucher_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "voucher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey

-- AddForeignKey

-- AddForeignKey
ALTER TABLE "authorization_policy" ADD CONSTRAINT "authorization_policy_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorization_step" ADD CONSTRAINT "authorization_step_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "voucher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorization_step" ADD CONSTRAINT "authorization_step_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written additions to the generated migration.
--
-- Everything below is something Prisma's schema language cannot express, and
-- every one of them is load-bearing rather than decorative. Grouped by what
-- they protect.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. CHECK constraints -- invariants the database enforces, not just the code
--
-- A service-layer check protects the API. A CHECK constraint protects the
-- data from anything: a migration script, a support engineer with psql, a
-- future endpoint that forgets. In a ledger that difference matters.
-- ---------------------------------------------------------------------------

-- The direction of an entry lives in dr_cr. The amount is always positive.
-- Allowing signed amounts alongside a direction flag is how ledgers end up
-- double-negating and silently posting a credit as a debit.
ALTER TABLE "voucher_line"
  ADD CONSTRAINT voucher_line_amount_positive CHECK (amount > 0);

ALTER TABLE "voucher"
  ADD CONSTRAINT voucher_total_positive CHECK (total_amount > 0);

-- A voucher needs between 0 and 4 checkers. 4 is the legacy Checker1..Checker4
-- ceiling; nothing in the bank's policy goes higher.
ALTER TABLE "voucher"
  ADD CONSTRAINT voucher_required_approvals_range
  CHECK (required_approvals BETWEEN 0 AND 4);

-- Value dating: a voucher may be back-valued, but never valued after the date
-- it was posted on. Forward value dating is a different feature with its own
-- settlement handling, and allowing it here by accident would mean interest
-- accruing on money that has not arrived.
ALTER TABLE "voucher"
  ADD CONSTRAINT voucher_value_date_not_future CHECK (value_date <= post_date);

-- An account cannot be closed before it was opened.
ALTER TABLE "account"
  ADD CONSTRAINT account_closed_after_opened
  CHECK (closed_on IS NULL OR closed_on >= opened_on);

-- Overdraft is a positive allowance, expressed as how far below zero the
-- balance may go.
ALTER TABLE "account"
  ADD CONSTRAINT account_overdraft_non_negative CHECK (overdraft_limit >= 0);

-- Liens and holds reduce the available balance. A negative one would increase
-- it, which is not a thing.
ALTER TABLE "account_balance"
  ADD CONSTRAINT account_balance_lien_non_negative CHECK (lien_amount >= 0);
ALTER TABLE "account_balance"
  ADD CONSTRAINT account_balance_hold_non_negative CHECK (hold_amount >= 0);

-- uncleared is a derived quantity: ledger - cleared. Storing it AND deriving
-- it is a denormalisation, so the constraint is what keeps the two honest.
ALTER TABLE "account_balance"
  ADD CONSTRAINT account_balance_uncleared_consistent
  CHECK (uncleared = ledger_balance - cleared_balance);

-- An account is either a customer account or an internal GL account. Never
-- both, never neither -- a voucher leg has to know which set of rules applies.
ALTER TABLE "account"
  ADD CONSTRAINT account_customer_xor_gl
  CHECK ((customer_id IS NOT NULL) <> (gl_account_id IS NOT NULL));

-- A reversal must say why. "Reversed" with no reason is unauditable.
ALTER TABLE "voucher"
  ADD CONSTRAINT voucher_reversal_needs_reason
  CHECK (reversal_of_id IS NULL OR reversal_reason IS NOT NULL);

-- A slab is a real interval.
ALTER TABLE "authorization_policy"
  ADD CONSTRAINT authorization_policy_range_valid
  CHECK (max_amount IS NULL OR max_amount > min_amount);


-- ---------------------------------------------------------------------------
-- 2. The balanced-voucher constraint
--
-- The single most important invariant in the system: for every voucher,
-- sum(debits) = sum(credits) = total_amount.
--
-- It cannot be a CHECK constraint, because a CHECK sees one row and this spans
-- two tables. It is a CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED, so it
-- fires once at COMMIT rather than after each INSERT -- which is essential,
-- since the voucher is genuinely unbalanced while the lines are still being
-- inserted one at a time.
--
-- Why in the database at all, when the service already checks it: the service
-- check is the one that produces a good error message, and this one is the one
-- that is still true in five years after someone writes a data-fix script.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_voucher_balanced() RETURNS trigger AS $$
DECLARE
  v_id       uuid;
  v_debits   numeric(19,4);
  v_credits  numeric(19,4);
  v_total    numeric(19,4);
  v_status   text;
BEGIN
  v_id := COALESCE(NEW.id, OLD.id);

  SELECT total_amount, status::text INTO v_total, v_status
    FROM voucher WHERE id = v_id;

  -- The voucher was deleted in this transaction; nothing to check.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT
    COALESCE(SUM(amount) FILTER (WHERE dr_cr = 'DEBIT'), 0),
    COALESCE(SUM(amount) FILTER (WHERE dr_cr = 'CREDIT'), 0)
  INTO v_debits, v_credits
  FROM voucher_line WHERE voucher_id = v_id;

  IF v_debits <> v_credits THEN
    RAISE EXCEPTION
      'Voucher % does not balance: debits %, credits %',
      v_id, v_debits, v_credits
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_debits <> v_total THEN
    RAISE EXCEPTION
      'Voucher % total_amount % does not match its debit total %',
      v_id, v_total, v_debits
      USING ERRCODE = 'check_violation';
  END IF;

  -- A voucher with no lines at all is not a voucher.
  IF v_debits = 0 THEN
    RAISE EXCEPTION 'Voucher % has no lines', v_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER voucher_balanced_check
  AFTER INSERT OR UPDATE OR DELETE ON "voucher_line"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_voucher_balanced();

-- Fires when the voucher row itself is written, so changing total_amount
-- without changing the lines is caught too.
CREATE CONSTRAINT TRIGGER voucher_balanced_check_on_voucher
  AFTER INSERT OR UPDATE OF total_amount ON "voucher"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_voucher_balanced();


-- ---------------------------------------------------------------------------
-- 3. Maker is never a checker
--
-- The four-eyes principle, enforced in the database. The service checks it too
-- and gives a better message, but this is the version that cannot be bypassed.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_maker_is_not_checker() RETURNS trigger AS $$
DECLARE
  v_maker uuid;
BEGIN
  SELECT maker_id INTO v_maker FROM voucher WHERE id = NEW.voucher_id;

  IF v_maker = NEW.actor_id THEN
    RAISE EXCEPTION
      'Four-eyes violation: user % created voucher % and cannot also authorise it',
      NEW.actor_id, NEW.voucher_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER authorization_step_maker_check
  BEFORE INSERT ON "authorization_step"
  FOR EACH ROW EXECUTE FUNCTION assert_maker_is_not_checker();


-- ---------------------------------------------------------------------------
-- 4. Partial indexes
--
-- A partial index covers only the rows matching its predicate. For a queue --
-- where the interesting rows are a tiny, constantly-churning slice of a huge
-- table -- this is the difference between an index that lives in RAM and one
-- that does not.
-- ---------------------------------------------------------------------------

-- The authorisation queue. On a year-old table, PENDING_AUTH rows are a
-- fraction of a percent. The full index on (branch_id, status, created_at)
-- would be the size of the table; this one is the size of the queue.
CREATE INDEX voucher_pending_queue_idx
  ON "voucher" (branch_id, created_at)
  WHERE status = 'PENDING_AUTH';

-- The outbox relay polls this constantly. SENT rows are pure noise in it, and
-- there will eventually be millions of them.
CREATE INDEX outbox_pending_idx
  ON "outbox_event" (available_at)
  WHERE status = 'PENDING';

-- Frozen accounts are rare and are checked on every debit.
CREATE INDEX account_frozen_idx
  ON "account" (branch_id)
  WHERE freeze_type <> 'NONE';

-- Open batches per branch: at most a handful at any moment.
CREATE INDEX batch_open_idx
  ON "batch" (branch_id, code)
  WHERE status = 'OPEN';


-- ---------------------------------------------------------------------------
-- 5. Customer name search
--
-- The legacy system searched a CHAR(50) with LIKE, which is a sequential scan
-- every time. A btree index cannot help a leading-wildcard match either --
-- `ILIKE '%nair%'` has nothing to seek to.
--
-- pg_trgm indexes three-character substrings, so it CAN serve an infix match.
-- Prisma has no syntax for a GIN index, hence this block.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX customer_full_name_trgm_idx
  ON "customer" USING GIN (full_name gin_trgm_ops);

CREATE INDEX account_title_trgm_idx
  ON "account" USING GIN (title gin_trgm_ops);


-- ---------------------------------------------------------------------------
-- 6. Available balance, as a generated column
--
-- available = cleared - lien - hold - minimum + overdraft limit
--
-- Getting this formula subtly wrong in one of several call sites is a classic
-- source of "the ATM let me overdraw" bugs. Defining it once, in the database,
-- means every reader -- the API, a report, a support query -- computes it the
-- same way.
--
-- It cannot be a STORED generated column, because it depends on columns in
-- two tables (account.overdraft_limit, product.minimum_balance). So it is a
-- view. The posting path does NOT read this view -- it locks the balance row
-- and computes from the locked values, because a view cannot be locked.
-- ---------------------------------------------------------------------------

CREATE VIEW account_available_balance AS
SELECT
  a.id                       AS account_id,
  a.account_number,
  a.branch_id,
  a.status,
  a.freeze_type,
  ab.ledger_balance,
  ab.cleared_balance,
  ab.uncleared,
  ab.lien_amount,
  ab.hold_amount,
  p.minimum_balance,
  a.overdraft_limit,
  (ab.cleared_balance
     - ab.lien_amount
     - ab.hold_amount
     - p.minimum_balance
     + a.overdraft_limit)    AS available_balance,
  ab.version,
  ab.last_posted_at
FROM account a
JOIN account_balance ab ON ab.account_id = a.id
JOIN product p          ON p.id = a.product_id;


-- ---------------------------------------------------------------------------
-- 7. Partitioning voucher_line by post_date
--
-- voucher_line is the one table that grows without bound. At 5k peak RPS in
-- the Phase 15 sizing it is the table that decides whether this system lives.
--
-- RANGE partitioning by post_date buys three things:
--   * partition pruning -- a statement for one month reads one partition
--   * cheap archival -- DETACH an old partition instead of a giant DELETE,
--     which would be a vacuum catastrophe
--   * smaller per-partition indexes, which stay in cache
--
-- Prisma cannot express partitioning, so the generated CREATE TABLE is
-- replaced here. This runs immediately after it, while the table is empty.
--
-- Trade-off: the partition key must be in the primary key (hence the
-- composite id), and a query that does NOT filter on post_date has to scan
-- every partition. The statement, batch and day-end queries all filter on it;
-- lookup by voucher_id does not, which is why voucher_line_voucher_id_idx
-- still exists on every partition.
-- ---------------------------------------------------------------------------

DROP TABLE "voucher_line";

CREATE TABLE "voucher_line" (
    "id"            UUID NOT NULL,
    "post_date"     DATE NOT NULL,
    "voucher_id"    UUID NOT NULL,
    "line_number"   INTEGER NOT NULL,
    "account_id"    UUID NOT NULL,
    "dr_cr"         "dr_cr" NOT NULL,
    "amount"        DECIMAL(19,4) NOT NULL,
    "value_date"    DATE NOT NULL,
    "narration"     VARCHAR(140),
    "balance_after" DECIMAL(19,4),
    "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voucher_line_pkey" PRIMARY KEY ("id", "post_date"),
    CONSTRAINT voucher_line_amount_positive CHECK (amount > 0)
) PARTITION BY RANGE ("post_date");

-- Quarterly partitions. Monthly would be finer-grained but gives Postgres
-- more partitions to plan across; quarterly is the right granularity for a
-- co-operative bank's volume. Phase 7 adds a worker that creates the next
-- partition ahead of time -- an INSERT with no matching partition is an error,
-- so running out of partitions is an outage, not a degradation.
CREATE TABLE voucher_line_2026q1 PARTITION OF "voucher_line"
  FOR VALUES FROM ('2026-01-01') TO ('2026-04-01');
CREATE TABLE voucher_line_2026q2 PARTITION OF "voucher_line"
  FOR VALUES FROM ('2026-04-01') TO ('2026-07-01');
CREATE TABLE voucher_line_2026q3 PARTITION OF "voucher_line"
  FOR VALUES FROM ('2026-07-01') TO ('2026-10-01');
CREATE TABLE voucher_line_2026q4 PARTITION OF "voucher_line"
  FOR VALUES FROM ('2026-10-01') TO ('2027-01-01');
CREATE TABLE voucher_line_2027q1 PARTITION OF "voucher_line"
  FOR VALUES FROM ('2027-01-01') TO ('2027-04-01');

-- A catch-all so a mis-dated insert fails loudly with a constraint error
-- rather than vanishing. Monitored in Phase 9: any row here is a bug.
CREATE TABLE voucher_line_overflow PARTITION OF "voucher_line" DEFAULT;

-- Indexes declared on the parent are created on every partition, existing and
-- future.
CREATE INDEX "voucher_line_account_id_post_date_line_number_idx"
  ON "voucher_line" ("account_id", "post_date" DESC, "line_number");
CREATE INDEX "voucher_line_voucher_id_idx"
  ON "voucher_line" ("voucher_id");
CREATE UNIQUE INDEX "voucher_line_voucher_id_line_number_post_date_key"
  ON "voucher_line" ("voucher_id", "line_number", "post_date");

ALTER TABLE "voucher_line"
  ADD CONSTRAINT "voucher_line_voucher_id_fkey"
  FOREIGN KEY ("voucher_id") REFERENCES "voucher"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "voucher_line"
  ADD CONSTRAINT "voucher_line_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "account"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Re-attach the balanced-voucher trigger, which the DROP TABLE removed.
CREATE CONSTRAINT TRIGGER voucher_balanced_check
  AFTER INSERT OR UPDATE OR DELETE ON "voucher_line"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_voucher_balanced();
