import type { DrCr, TransactionType, VoucherStatus } from '@prisma/client';
import type { Money } from '../../shared/money/money';

/**
 * The ledger's own vocabulary.
 *
 * Note what a command looks like: the WHOLE voucher arrives in one object.
 *
 * That is the deliberate inversion of the legacy design, where a teller's
 * voucher was assembled across ten or twenty stateful SignalR round trips
 * (`GetInitialMessage` -> `InstrNoValidate` -> `FcyTrnAmtValidate` ->
 * `BuildVoucherArray` -> `CommitVoucher`) with the half-built voucher living in
 * `Context.Items` -- per-socket, in-process memory on one specific server.
 *
 * Here the client builds the voucher locally and posts it once. Any node can
 * serve it, a deploy loses nothing, and the request carries its own state.
 */

export interface VoucherLineCommand {
  accountId: string;
  drCr: DrCr;
  /** Always positive. Direction is in drCr. */
  amount: Money;
  narration?: string;
  /** Defaults to the voucher's value date. */
  valueDate?: string;
}

export interface CreateVoucherCommand {
  transactionType: TransactionType;
  narration: string;
  /** ISO date. Defaults to the branch business date. May be back-valued. */
  valueDate?: string;
  instrumentNumber?: string;
  instrumentDate?: string;
  lines: VoucherLineCommand[];
}

export interface VoucherLineView {
  id: string;
  lineNumber: number;
  accountId: string;
  accountNumber: string;
  accountTitle: string;
  drCr: DrCr;
  amount: string;
  valueDate: string;
  narration: string | null;
  balanceAfter: string | null;
}

export interface ApprovalView {
  level: number;
  actorId: string;
  actorName: string;
  decision: string;
  remarks: string | null;
  decidedAt: Date;
}

export interface VoucherView {
  id: string;
  voucherNumber: string;
  branchId: string;
  batchId: string;
  transactionType: TransactionType;
  status: VoucherStatus;
  entryDate: string;
  postDate: string;
  valueDate: string;
  totalAmount: string;
  currency: string;
  narration: string;
  instrumentNumber: string | null;
  makerId: string;
  makerName: string;
  requiredApprovals: number;
  approvalsGiven: number;
  postedAt: Date | null;
  reversalOfId: string | null;
  reversalReason: string | null;
  createdAt: Date;
  lines: VoucherLineView[];
  approvals: ApprovalView[];
}

/**
 * What a debit is actually checked against.
 *
 * available = cleared - lien - hold - minimum + overdraftLimit
 *
 * Six numbers, not one. The legacy D009022 had all of them and the check was
 * re-implemented per screen; getting it subtly different in one place is the
 * classic "the ATM let me overdraw" bug. It is computed in exactly one
 * function here, and mirrored by the `account_available_balance` view so a
 * report and a support query cannot disagree with the posting path.
 */
export interface AvailableBalance {
  accountId: string;
  ledgerBalance: Money;
  clearedBalance: Money;
  uncleared: Money;
  lienAmount: Money;
  holdAmount: Money;
  minimumBalance: Money;
  overdraftLimit: Money;
  available: Money;
  version: number;
}
