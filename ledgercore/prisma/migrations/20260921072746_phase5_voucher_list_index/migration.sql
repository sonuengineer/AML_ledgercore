-- DropIndex
DROP INDEX "account_title_trgm_idx";

-- DropIndex
DROP INDEX "customer_full_name_trgm_idx";

-- CreateIndex
CREATE INDEX "voucher_branch_id_created_at_id_idx" ON "voucher"("branch_id", "created_at" DESC, "id" DESC);
