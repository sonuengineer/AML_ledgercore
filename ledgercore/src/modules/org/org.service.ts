import type { BranchStatus, DayStatus } from '@prisma/client';
import { BusinessRuleError, NotFoundError } from '../../shared/errors/AppError';
import * as repo from './org.repository';

/**
 * Organisation rules: branches, and the business date that governs posting.
 *
 * Phase 5 and Phase 7 both build on `assertPostingAllowed`. It is written now,
 * with the ledger in mind, because getting the business-date semantics right is
 * a precondition for any correct posting -- and because reading `new Date()`
 * on a Node instance would make value dating depend on which node served the
 * request, turning clock skew into a correctness bug.
 */

export interface BranchView {
  id: string;
  code: number;
  name: string;
  status: BranchStatus;
  openedOn: Date;
}

export interface BusinessDateView {
  branchId: string;
  workingDate: string;
  status: DayStatus;
  openedAt: Date | null;
  closedAt: Date | null;
}

const toBranchView = (branch: repo.Branch): BranchView => ({
  id: branch.id,
  code: branch.code,
  name: branch.name,
  status: branch.status,
  openedOn: branch.openedOn,
});

/** ISO date only (YYYY-MM-DD). The business date has no time component. */
const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

export const listBranches = async (bankId?: string): Promise<BranchView[]> => {
  const branches = await repo.listBranches({ bankId });
  return branches.map(toBranchView);
};

export const getBranch = async (id: string): Promise<BranchView> => {
  const branch = await repo.findBranchById(id);
  if (!branch) throw new NotFoundError('Branch', id);
  return toBranchView(branch);
};

export const getCurrentBusinessDate = async (branchId: string): Promise<BusinessDateView> => {
  const branch = await repo.findBranchById(branchId);
  if (!branch) throw new NotFoundError('Branch', branchId);

  const businessDate = await repo.findCurrentBusinessDate(branchId);
  if (!businessDate) {
    throw new BusinessRuleError(
      'DAY_NOT_OPEN',
      'This branch has no open business date. Day begin has not been run.',
      { branchId, branchCode: branch.code },
    );
  }

  return {
    branchId: businessDate.branchId,
    workingDate: toIsoDate(businessDate.workingDate),
    status: businessDate.status,
    openedAt: businessDate.openedAt,
    closedAt: businessDate.closedAt,
  };
};

/**
 * The gate every posting passes through in Phase 5.
 *
 * Returns the working date to stamp on the voucher, or throws a business rule
 * error that names exactly which condition failed -- because "posting failed"
 * with no reason is the support ticket nobody can close.
 */
export const assertPostingAllowed = async (branchId: string): Promise<Date> => {
  const branch = await repo.findBranchById(branchId);
  if (!branch) throw new NotFoundError('Branch', branchId);

  if (branch.status !== 'ACTIVE') {
    throw new BusinessRuleError('BRANCH_NOT_ACTIVE', 'This branch is not accepting transactions', {
      branchCode: branch.code,
      status: branch.status,
    });
  }

  const businessDate = await repo.findCurrentBusinessDate(branchId);

  if (!businessDate) {
    throw new BusinessRuleError('DAY_NOT_OPEN', 'Day begin has not been run for this branch', {
      branchCode: branch.code,
    });
  }

  if (businessDate.status === 'CLOSING') {
    throw new BusinessRuleError(
      'DAY_CLOSING',
      'Day end is in progress. No new transactions can be posted.',
      { branchCode: branch.code, workingDate: toIsoDate(businessDate.workingDate) },
    );
  }

  if (businessDate.status !== 'OPEN') {
    throw new BusinessRuleError('DAY_NOT_OPEN', 'The business day is not open', {
      branchCode: branch.code,
      status: businessDate.status,
    });
  }

  return businessDate.workingDate;
};
