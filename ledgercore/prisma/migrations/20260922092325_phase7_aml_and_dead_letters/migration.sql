-- CreateEnum
CREATE TYPE "aml_rule_kind" AS ENUM ('CASH_THRESHOLD', 'STRUCTURING', 'VELOCITY');

-- CreateEnum
CREATE TYPE "alert_status" AS ENUM ('OPEN', 'UNDER_REVIEW', 'ESCALATED', 'CLOSED_NO_ACTION', 'REVERTED');

-- DropIndex
DROP INDEX "customer_full_name_trgm_idx";

-- CreateTable
CREATE TABLE "aml_rule" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "kind" "aml_rule_kind" NOT NULL,
    "window_days" INTEGER NOT NULL,
    "threshold" DECIMAL(19,4) NOT NULL,
    "min_count" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "aml_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aml_alert" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "rule_version" INTEGER NOT NULL,
    "customer_id" UUID NOT NULL,
    "account_id" UUID,
    "branch_id" UUID NOT NULL,
    "evidence" JSONB NOT NULL,
    "observed_amount" DECIMAL(19,4) NOT NULL,
    "window_from" DATE NOT NULL,
    "window_to" DATE NOT NULL,
    "status" "alert_status" NOT NULL DEFAULT 'OPEN',
    "assigned_to_id" UUID,
    "review_notes" VARCHAR(500),
    "reviewed_at" TIMESTAMPTZ(6),
    "dedupe_key" VARCHAR(160) NOT NULL,
    "triggered_by_voucher_id" UUID,
    "request_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "aml_alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dead_letter" (
    "id" UUID NOT NULL,
    "queue_name" VARCHAR(60) NOT NULL,
    "job_name" VARCHAR(60) NOT NULL,
    "job_id" VARCHAR(80),
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL,
    "last_error" VARCHAR(1000) NOT NULL,
    "error_stack" TEXT,
    "request_id" VARCHAR(64),
    "replayed_at" TIMESTAMPTZ(6),
    "replayed_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dead_letter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "aml_rule_code_key" ON "aml_rule"("code");

-- CreateIndex
CREATE INDEX "aml_rule_is_active_kind_idx" ON "aml_rule"("is_active", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "aml_alert_dedupe_key_key" ON "aml_alert"("dedupe_key");

-- CreateIndex
CREATE INDEX "aml_alert_branch_id_status_created_at_idx" ON "aml_alert"("branch_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "aml_alert_customer_id_created_at_idx" ON "aml_alert"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "aml_alert_rule_id_created_at_idx" ON "aml_alert"("rule_id", "created_at");

-- CreateIndex
CREATE INDEX "dead_letter_queue_name_created_at_idx" ON "dead_letter"("queue_name", "created_at");

-- CreateIndex
CREATE INDEX "dead_letter_replayed_at_idx" ON "dead_letter"("replayed_at");

-- AddForeignKey
ALTER TABLE "aml_alert" ADD CONSTRAINT "aml_alert_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "aml_rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aml_alert" ADD CONSTRAINT "aml_alert_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aml_alert" ADD CONSTRAINT "aml_alert_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aml_alert" ADD CONSTRAINT "aml_alert_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

