import type { TransactionType, VoucherStatus } from '@prisma/client';
import { BusinessRuleError, NotFoundError } from '../../shared/errors/AppError';
import { prisma, transaction } from '../../shared/db/prisma';
import { buildPage, type Page } from '../../shared/http/pagination';
import { assertPostingAllowed } from '../org/org.service';
import type { Actor } from '../identity/identity.service';
import * as repo from './ledger.repository';
import * as posting from './posting.service';
import type { CreateVoucherCommand, VoucherView } from './ledger.types';

/**
 * Ledger orchestration: resolve the posting context, then delegate.
 *
 * The split from posting.service is deliberate. This file answers "which
 * business date, which batch, is this branch even open"; posting.service
 * answers "does this voucher balance and may these accounts move". Keeping
 * them apart means the invariants can be tested without a branch calendar.
 */

const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Find or open the batch this voucher belongs in.
 *
 * Legacy `GetBatchProperty(lbrCode, batchCode, EntryDate, validateBatchStat)`.
 * A voucher can only be posted into an OPEN batch on the branch's current
 * business date -- that is what makes "close the batch" a meaningful control.
 *
 * Batches are opened lazily on first use rather than by day-begin, so a branch
 * that never takes a cash transaction does not carry an empty cash batch.
 */
const resolveBatch = async (
  branchId: string,
  businessDateId: string,
  transactionType: TransactionType,
): Promise<string> =>
  transaction(async (tx) => {
    const code = transactionType;

    const existing = await tx.batch.findUnique({
      where: { businessDateId_code: { businessDateId, code } },
    });

    if (existing) {
      if (existing.status !== 'OPEN') {
        throw new BusinessRuleError(
          'BATCH_CLOSED',
          `The ${code.toLowerCase()} batch for this business date is closed. No further postings.`,
          { batchCode: code },
        );
      }
      return existing.id;
    }

    // Two tellers can hit this simultaneously on the day's first voucher.
    // The unique on (business_date_id, code) decides it; the loser just reads
    // the winner's row.
    try {
      const created = await tx.batch.create({
        data: { branchId, businessDateId, code },
      });
      return created.id;
    } catch {
      const row = await tx.batch.findUniqueOrThrow({
        where: { businessDateId_code: { businessDateId, code } },
      });
      return row.id;
    }
  });

const buildContext = async (
  actor: Actor,
  transactionType: TransactionType,
): Promise<posting.CreateVoucherContext> => {
  // Throws BRANCH_NOT_ACTIVE / DAY_NOT_OPEN / DAY_CLOSING with a named reason.
  const workingDate = await assertPostingAllowed(actor.branchId);

  const businessDate = await prisma.businessDate.findUniqueOrThrow({
    where: { branchId_workingDate: { branchId: actor.branchId, workingDate } },
    select: { id: true },
  });

  const batchId = await resolveBatch(actor.branchId, businessDate.id, transactionType);

  return {
    actor,
    branchId: actor.branchId,
    branchCode: actor.branchCode,
    businessDateId: businessDate.id,
    workingDate,
    batchId,
  };
};

export const createVoucher = async (
  command: CreateVoucherCommand,
  actor: Actor,
): Promise<posting.CreateVoucherResult> =>
  posting.createVoucher(command, await buildContext(actor, command.transactionType));

export const approveVoucher = posting.approveVoucher;
export const rejectVoucher = posting.rejectVoucher;

export const reverseVoucher = async (
  voucherId: string,
  reason: string,
  actor: Actor,
): Promise<posting.CreateVoucherResult> => {
  const original = await prisma.voucher.findUnique({
    where: { id: voucherId },
    select: { transactionType: true, branchId: true },
  });
  if (!original) throw new NotFoundError('Voucher', voucherId);

  if (original.branchId !== actor.branchId && !actor.multiBranchAccess) {
    throw new BusinessRuleError(
      'CROSS_BRANCH_REVERSAL',
      'A voucher can only be reversed at the branch that posted it.',
    );
  }

  return posting.reverseVoucher(
    voucherId,
    reason,
    await buildContext(actor, original.transactionType),
  );
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const toVoucherView = (voucher: repo.VoucherWithDetail): VoucherView => ({
  id: voucher.id,
  voucherNumber: voucher.voucherNumber,
  branchId: voucher.branchId,
  batchId: voucher.batchId,
  transactionType: voucher.transactionType,
  status: voucher.status,
  entryDate: toIsoDate(voucher.entryDate),
  postDate: toIsoDate(voucher.postDate),
  valueDate: toIsoDate(voucher.valueDate),
  totalAmount: voucher.totalAmount.toFixed(2),
  currency: voucher.currency,
  narration: voucher.narration,
  instrumentNumber: voucher.instrumentNumber,
  makerId: voucher.makerId,
  makerName: voucher.maker.displayName,
  requiredApprovals: voucher.requiredApprovals,
  approvalsGiven: voucher.approvals.filter((step) => step.decision === 'APPROVED').length,
  postedAt: voucher.postedAt,
  reversalOfId: voucher.reversalOfId,
  reversalReason: voucher.reversalReason,
  createdAt: voucher.createdAt,
  lines: voucher.lines.map((line) => ({
    id: line.id,
    lineNumber: line.lineNumber,
    accountId: line.accountId,
    accountNumber: line.account.accountNumber,
    accountTitle: line.account.title,
    drCr: line.drCr,
    amount: line.amount.toFixed(2),
    valueDate: toIsoDate(line.valueDate),
    narration: line.narration,
    balanceAfter: line.balanceAfter ? line.balanceAfter.toFixed(2) : null,
  })),
  approvals: voucher.approvals.map((step) => ({
    level: step.level,
    actorId: step.actorId,
    actorName: step.actor.displayName,
    decision: step.decision,
    remarks: step.remarks,
    decidedAt: step.decidedAt,
  })),
});

export const getVoucher = async (id: string): Promise<VoucherView> => {
  const voucher = await repo.findVoucherById(id);
  if (!voucher) throw new NotFoundError('Voucher', id);
  return toVoucherView(voucher);
};

export interface VoucherListItem {
  id: string;
  voucherNumber: string;
  transactionType: TransactionType;
  status: VoucherStatus;
  totalAmount: string;
  narration: string;
  makerName: string;
  requiredApprovals: number;
  approvalsGiven: number;
  postDate: string;
  createdAt: Date;
}

/**
 * The authorisation queue -- the hottest screen in a branch.
 *
 * `status = PENDING_AUTH` on a branch is served by the PARTIAL index
 * `voucher_pending_queue_idx`, which covers only pending rows. On a year-old
 * table those are a fraction of a percent, so that index stays small enough to
 * live in cache while a full index on the same columns would be the size of
 * the table.
 */
export const listVouchers = async (params: {
  branchId: string;
  status?: VoucherStatus;
  limit: number;
  cursor?: string;
}): Promise<Page<VoucherListItem>> => {
  const { decodeCursor } = await import('../../shared/http/pagination');
  const cursor = decodeCursor(params.cursor);

  const rows = await prisma.voucher.findMany({
    where: {
      branchId: params.branchId,
      ...(params.status ? { status: params.status } : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: new Date(cursor.createdAt) } },
              { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    include: { maker: { select: { displayName: true } }, approvals: { select: { decision: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: params.limit + 1,
  });

  return buildPage(
    rows.map((voucher) => ({
      id: voucher.id,
      createdAt: voucher.createdAt,
      voucherNumber: voucher.voucherNumber,
      transactionType: voucher.transactionType,
      status: voucher.status,
      totalAmount: voucher.totalAmount.toFixed(2),
      narration: voucher.narration,
      makerName: voucher.maker.displayName,
      requiredApprovals: voucher.requiredApprovals,
      approvalsGiven: voucher.approvals.filter((step) => step.decision === 'APPROVED').length,
      postDate: toIsoDate(voucher.postDate),
    })),
    params.limit,
  );
};

export const getAvailableBalance = async (accountId: string) => {
  const row = await repo.readAvailableBalance(accountId);
  if (!row) throw new NotFoundError('Account', accountId);
  return row;
};

export interface StatementPage {
  accountId: string;
  fromDate: string;
  toDate: string;
  lines: Array<{
    id: string;
    postDate: string;
    valueDate: string;
    voucherNumber: string;
    drCr: string;
    amount: string;
    balanceAfter: string | null;
    narration: string | null;
  }>;
  nextCursor: string | null;
  hasMore: boolean;
}

export const getStatement = async (params: {
  accountId: string;
  fromDate: Date;
  toDate: Date;
  limit: number;
  cursor?: string;
}): Promise<StatementPage> => {
  // The statement cursor is (postDate, lineNumber) rather than the generic
  // (createdAt, id): it has to match the index's sort order exactly, or the
  // planner adds a Sort node and the whole point is lost.
  let cursorPostDate: Date | undefined;
  let cursorLineNumber: number | undefined;

  if (params.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')) as {
        d: string;
        l: number;
      };
      cursorPostDate = new Date(decoded.d);
      cursorLineNumber = decoded.l;
    } catch {
      const { ValidationError } = await import('../../shared/errors/AppError');
      throw new ValidationError('Invalid statement cursor');
    }
  }

  const rows = await repo.findStatementLines({
    accountId: params.accountId,
    fromDate: params.fromDate,
    toDate: params.toDate,
    limit: params.limit,
    ...(cursorPostDate ? { cursorPostDate } : {}),
    ...(cursorLineNumber !== undefined ? { cursorLineNumber } : {}),
  });

  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;
  const last = page[page.length - 1];

  return {
    accountId: params.accountId,
    fromDate: toIsoDate(params.fromDate),
    toDate: toIsoDate(params.toDate),
    lines: page.map((row) => ({
      id: row.id,
      postDate: toIsoDate(row.postDate),
      valueDate: toIsoDate(row.valueDate),
      voucherNumber: row.voucherNumber,
      drCr: row.drCr,
      amount: Number(row.amount).toFixed(2),
      balanceAfter: row.balanceAfter ? Number(row.balanceAfter).toFixed(2) : null,
      narration: row.narration,
    })),
    hasMore,
    nextCursor:
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ d: toIsoDate(last.postDate), l: last.lineNumber }),
            'utf8',
          ).toString('base64url')
        : null,
  };
};
