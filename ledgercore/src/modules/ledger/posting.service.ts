import { Prisma, type DrCr, type TransactionType } from '@prisma/client';
import {
  BusinessRuleError,
  ConcurrencyError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/AppError';
import { transaction, type TxClient } from '../../shared/db/prisma';
import { moduleLogger } from '../../shared/logging/logger';
import { getRequestId } from '../../shared/logging/context';
import {
  add,
  compare,
  equals,
  isPositive,
  money,
  negate,
  subtract,
  sum,
  type Money,
} from '../../shared/money/money';
import { vouchersPosted, vouchersRejected } from '../../shared/metrics/registry';
import type { Actor } from '../identity/identity.service';
import * as repo from './ledger.repository';
import type { CreateVoucherCommand, VoucherLineCommand } from './ledger.types';

const log = moduleLogger('ledger');

/**
 * The posting engine.
 *
 * Everything in this file exists to protect five invariants:
 *
 *   1. sum(debits) = sum(credits), to the paisa
 *   2. no debit takes an account below its available balance
 *   3. the maker is never a checker, and a voucher posts only when every
 *      required approval level is filled
 *   4. a retried request posts once
 *   5. balances and the events announcing them commit together, or not at all
 *
 * The database backstops 1, 3 and parts of 2 with constraints and triggers.
 * The checks here exist because a constraint gives a terrible error message --
 * "voucher does not balance: debits 100, credits 90" is for the log, and
 * "Debits total 100.00 but credits total 90.00" is for the teller.
 */

// ---------------------------------------------------------------------------
// Available balance
// ---------------------------------------------------------------------------

/**
 * available = cleared - lien - hold - minimum + overdraftLimit
 *
 * Defined once. Every other reader goes through the `account_available_balance`
 * view, which computes the same expression, so a report and the posting path
 * cannot drift apart.
 */
const availableFrom = (row: repo.LockedBalance): Money => {
  const cleared = money(row.clearedBalance);
  const lien = money(row.lienAmount);
  const hold = money(row.holdAmount);
  const minimum = money(row.minimumBalance);
  const overdraft = money(row.overdraftLimit);

  return add(subtract(subtract(subtract(cleared, lien), hold), minimum), overdraft);
};

/**
 * Which way a debit moves the balance.
 *
 * This is the sign convention that ledgers get wrong. On a LIABILITY account
 * (a customer's savings deposit -- the bank owes them) a debit REDUCES the
 * balance. On an ASSET account (a loan, or the branch cash head) a debit
 * INCREASES it. Encoding the side on the product and deriving the sign here,
 * once, beats scattering `if (isLoan)` across the codebase.
 */
const signedDelta = (drCr: DrCr, amount: Money, side: 'ASSET' | 'LIABILITY'): Money => {
  const increases = side === 'ASSET' ? drCr === 'DEBIT' : drCr === 'CREDIT';
  // `negate`, not string concatenation. The first version of this file built
  // the negative with a template literal and, two functions down, did it again
  // to an already-negative value -- producing "--49500.0000", which decimal.js
  // rejected as an invalid argument and surfaced as a 500. Exactly the
  // double-negation this file's own comments warn about.
  return increases ? amount : negate(amount);
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const assertBalanced = (lines: readonly VoucherLineCommand[]): Money => {
  const debits = sum(lines.filter((line) => line.drCr === 'DEBIT').map((line) => line.amount));
  const credits = sum(lines.filter((line) => line.drCr === 'CREDIT').map((line) => line.amount));

  if (!equals(debits, credits)) {
    throw new BusinessRuleError(
      'VOUCHER_NOT_BALANCED',
      `Debits total ${debits} but credits total ${credits}. A voucher must balance.`,
      { debits, credits, difference: subtract(debits, credits) },
    );
  }

  if (!isPositive(debits)) {
    throw new BusinessRuleError('VOUCHER_EMPTY', 'A voucher must move a positive amount.');
  }

  return debits;
};

const assertTransactionTypeAllowed = (
  row: repo.LockedBalance,
  drCr: DrCr,
  transactionType: TransactionType,
): void => {
  // Legacy D009021's CashDrTrnYN / TrfrCrTrnYN family. A product can forbid,
  // say, cash debits on a term loan account.
  const allowed =
    transactionType === 'CASH'
      ? drCr === 'DEBIT'
        ? row.allowCashDebit
        : row.allowCashCredit
      : transactionType === 'TRANSFER' || transactionType === 'CLEARING'
        ? drCr === 'DEBIT'
          ? row.allowTransferDebit
          : row.allowTransferCredit
        : true; // SYSTEM postings bypass product flags by design.

  if (!allowed) {
    throw new BusinessRuleError(
      'TRANSACTION_TYPE_NOT_ALLOWED',
      `Account ${row.accountNumber} does not accept ${transactionType.toLowerCase()} ${drCr.toLowerCase()}s.`,
      { accountNumber: row.accountNumber, transactionType, drCr },
    );
  }
};

const assertPostable = (row: repo.LockedBalance, drCr: DrCr): void => {
  if (row.accountStatus === 'CLOSED') {
    throw new BusinessRuleError('ACCOUNT_CLOSED', `Account ${row.accountNumber} is closed.`, {
      accountNumber: row.accountNumber,
    });
  }

  // Freeze blocks debits, or everything. Credits into a debit-frozen account
  // are deliberately allowed -- a salary must still land in an account frozen
  // for a KYC lapse.
  const frozen = [row.freezeType, row.customerFreezeType];
  if (frozen.includes('TOTAL')) {
    throw new BusinessRuleError('ACCOUNT_FROZEN', `Account ${row.accountNumber} is frozen.`, {
      accountNumber: row.accountNumber,
    });
  }
  if (drCr === 'DEBIT' && frozen.includes('DEBIT_BLOCKED')) {
    throw new BusinessRuleError(
      'ACCOUNT_DEBIT_FROZEN',
      `Debits are blocked on account ${row.accountNumber}.`,
      { accountNumber: row.accountNumber },
    );
  }
};

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateVoucherContext {
  actor: Actor;
  branchId: string;
  branchCode: number;
  businessDateId: string;
  workingDate: Date;
  batchId: string;
}

export interface CreateVoucherResult {
  voucherId: string;
  voucherNumber: string;
  status: string;
  requiredApprovals: number;
  approvalsGiven: number;
  totalAmount: string;
}

/**
 * Create a voucher.
 *
 * Validation happens BEFORE the transaction opens wherever it can, so a
 * malformed request never takes a row lock. Only the checks that need locked
 * state -- balances, freeze status -- run inside.
 */
export const createVoucher = async (
  command: CreateVoucherCommand,
  context: CreateVoucherContext,
): Promise<CreateVoucherResult> => {
  if (command.lines.length < 2) {
    throw new BusinessRuleError(
      'VOUCHER_TOO_FEW_LINES',
      'A voucher needs at least two lines -- something to debit and something to credit.',
    );
  }

  for (const line of command.lines) {
    if (!isPositive(line.amount)) {
      throw new BusinessRuleError(
        'LINE_AMOUNT_NOT_POSITIVE',
        'Every line amount must be positive. Direction is set by drCr, not by a minus sign.',
      );
    }
  }

  const totalAmount = assertBalanced(command.lines);

  const valueDate = command.valueDate ? new Date(command.valueDate) : context.workingDate;
  if (valueDate > context.workingDate) {
    throw new BusinessRuleError(
      'VALUE_DATE_IN_FUTURE',
      'Value date cannot be after the business date.',
      { valueDate: command.valueDate, businessDate: context.workingDate.toISOString().slice(0, 10) },
    );
  }

  // De-duplicate: a voucher may legitimately touch the same account twice
  // (a debit and a fee), and locking it twice in one statement is pointless.
  const accountIds = [...new Set(command.lines.map((line) => line.accountId))];

  const requiredApprovals = await repo.findRequiredApprovals(
    context.branchId,
    command.transactionType,
    totalAmount,
  );

  return transaction(async (tx) => {
    // ---- lock, in a globally consistent order ----------------------------
    const balances = await repo.lockBalancesForUpdate(accountIds, tx);
    const byAccount = new Map(balances.map((row) => [row.accountId, row]));

    const missing = accountIds.filter((id) => !byAccount.has(id));
    if (missing.length > 0) {
      throw new NotFoundError('Account', missing[0]);
    }

    // ---- per-line validation --------------------------------------------
    for (const line of command.lines) {
      const row = byAccount.get(line.accountId)!;
      assertPostable(row, line.drCr);
      assertTransactionTypeAllowed(row, line.drCr, command.transactionType);
    }

    // ---- available-balance check ----------------------------------------
    //
    // Netted per account first. A voucher that debits 100 and credits 40 on
    // the same account only needs 60 available; checking each line separately
    // would reject a legitimate voucher.
    const netByAccount = new Map<string, Money>();
    for (const line of command.lines) {
      const row = byAccount.get(line.accountId)!;
      const delta = signedDelta(line.drCr, line.amount, row.balanceSide);
      netByAccount.set(line.accountId, add(netByAccount.get(line.accountId) ?? money('0'), delta));
    }

    for (const [accountId, net] of netByAccount) {
      const row = byAccount.get(accountId)!;
      // Only a net reduction can breach the floor.
      if (compare(net, money('0')) >= 0) continue;

      const available = availableFrom(row);
      const required = negate(net);

      if (compare(available, required) < 0) {
        throw new BusinessRuleError(
          'INSUFFICIENT_FUNDS',
          `Account ${row.accountNumber} has ${available} available but the voucher needs ${required}.`,
          {
            accountNumber: row.accountNumber,
            available,
            required,
            clearedBalance: row.clearedBalance,
            lienAmount: row.lienAmount,
            holdAmount: row.holdAmount,
            minimumBalance: row.minimumBalance,
            overdraftLimit: row.overdraftLimit,
          },
        );
      }
    }

    // ---- write ------------------------------------------------------------
    const voucherNumber = await repo.nextVoucherNumber(
      context.branchCode,
      context.workingDate,
      tx,
    );

    const voucher = await tx.voucher.create({
      data: {
        voucherNumber,
        branchId: context.branchId,
        batchId: context.batchId,
        transactionType: command.transactionType,
        status: 'PENDING_AUTH',
        entryDate: context.workingDate,
        postDate: context.workingDate,
        valueDate,
        totalAmount: new Prisma.Decimal(totalAmount),
        narration: command.narration,
        instrumentNumber: command.instrumentNumber ?? null,
        instrumentDate: command.instrumentDate ? new Date(command.instrumentDate) : null,
        makerId: context.actor.userId,
        requiredApprovals,
      },
    });

    await repo.insertVoucherLines(
      command.lines.map((line, index) => ({
        voucherId: voucher.id,
        postDate: context.workingDate,
        lineNumber: index + 1,
        accountId: line.accountId,
        drCr: line.drCr,
        amount: line.amount,
        valueDate: line.valueDate ? new Date(line.valueDate) : valueDate,
        narration: line.narration,
      })),
      tx,
    );

    await writeOutbox(
      tx,
      'voucher.created',
      voucher.id,
      { voucherId: voucher.id, voucherNumber, totalAmount, requiredApprovals },
    );

    // A slab of 0 approvals means the maker's own entry posts immediately --
    // small cash receipts, system postings. The four-eyes rule is a policy
    // decision per amount band, not a universal law.
    let status: string = 'PENDING_AUTH';
    if (requiredApprovals === 0) {
      await applyPosting(voucher.id, tx);
      status = 'POSTED';
    }

    log.info(
      { voucherId: voucher.id, voucherNumber, totalAmount, requiredApprovals, status },
      'voucher created',
    );

    return {
      voucherId: voucher.id,
      voucherNumber,
      status,
      requiredApprovals,
      approvalsGiven: 0,
      totalAmount,
    };
  });
};

// ---------------------------------------------------------------------------
// Approve / reject
// ---------------------------------------------------------------------------

export interface DecisionResult {
  voucherId: string;
  status: string;
  approvalsGiven: number;
  requiredApprovals: number;
  posted: boolean;
}

export const approveVoucher = async (
  voucherId: string,
  actor: Actor,
  remarks?: string,
): Promise<DecisionResult> =>
  transaction(async (tx) => {
    // Lock first. Two checkers clicking Approve simultaneously would otherwise
    // both see the last required level as theirs and both post the voucher.
    const locked = await repo.lockVoucherForUpdate(voucherId, tx);
    if (!locked) throw new NotFoundError('Voucher', voucherId);

    if (locked.status !== 'PENDING_AUTH') {
      throw new BusinessRuleError(
        'VOUCHER_NOT_PENDING',
        `This voucher is ${locked.status.toLowerCase()} and cannot be authorised.`,
        { status: locked.status },
      );
    }

    // Four eyes. The database enforces this too, via a trigger; this is the
    // version that produces a sentence a human can act on.
    if (locked.makerId === actor.userId) {
      throw new ForbiddenError('You created this voucher and cannot also authorise it.', {
        rule: 'four_eyes',
      });
    }

    const given = await repo.countApprovals(voucherId, tx);
    const level = given + 1;

    try {
      await tx.authorizationStep.create({
        data: { voucherId, level, actorId: actor.userId, decision: 'APPROVED', remarks: remarks ?? null },
      });
    } catch (error) {
      // Unique on (voucher_id, actor_id) and on (voucher_id, level). Either
      // violation means a concurrent approval won the race.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BusinessRuleError(
          'ALREADY_AUTHORIZED',
          'You have already authorised this voucher.',
        );
      }
      throw error;
    }

    const posted = level >= locked.requiredApprovals;
    if (posted) await applyPosting(voucherId, tx);

    log.info(
      { voucherId, actorId: actor.userId, level, required: locked.requiredApprovals, posted },
      'voucher approval recorded',
    );

    return {
      voucherId,
      status: posted ? 'POSTED' : 'PENDING_AUTH',
      approvalsGiven: level,
      requiredApprovals: locked.requiredApprovals,
      posted,
    };
  });

export const rejectVoucher = async (
  voucherId: string,
  actor: Actor,
  remarks: string,
): Promise<DecisionResult> =>
  transaction(async (tx) => {
    const locked = await repo.lockVoucherForUpdate(voucherId, tx);
    if (!locked) throw new NotFoundError('Voucher', voucherId);

    if (locked.status !== 'PENDING_AUTH') {
      throw new BusinessRuleError(
        'VOUCHER_NOT_PENDING',
        `This voucher is ${locked.status.toLowerCase()} and cannot be rejected.`,
      );
    }
    if (locked.makerId === actor.userId) {
      throw new ForbiddenError('You created this voucher and cannot also reject it.', {
        rule: 'four_eyes',
      });
    }

    const given = await repo.countApprovals(voucherId, tx);
    await tx.authorizationStep.create({
      data: { voucherId, level: given + 1, actorId: actor.userId, decision: 'REJECTED', remarks },
    });
    await tx.voucher.update({ where: { id: voucherId }, data: { status: 'REJECTED' } });

    await writeOutbox(tx, 'voucher.rejected', voucherId, { voucherId, remarks });

    log.info({ voucherId, actorId: actor.userId }, 'voucher rejected');

    return {
      voucherId,
      status: 'REJECTED',
      approvalsGiven: given,
      requiredApprovals: locked.requiredApprovals,
      posted: false,
    };
  });

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

/**
 * Apply a fully-authorised voucher to balances.
 *
 * Only ever called inside an open transaction that already holds the voucher
 * row lock. It re-locks the balance rows, in account-id order, for the same
 * deadlock-avoidance reason as `createVoucher` -- and because the balances may
 * have moved between creation and approval, which is precisely why the
 * available-balance check is repeated here rather than trusted from earlier.
 */
const applyPosting = async (voucherId: string, tx: TxClient): Promise<void> => {
  const voucher = await tx.voucher.findUniqueOrThrow({
    where: { id: voucherId },
    include: { lines: { orderBy: { lineNumber: 'asc' } } },
  });

  const accountIds = [...new Set(voucher.lines.map((line) => line.accountId))];
  const balances = await repo.lockBalancesForUpdate(accountIds, tx);
  const byAccount = new Map(balances.map((row) => [row.accountId, row]));

  // Net per account, then apply once per account rather than once per line.
  // Two UPDATEs on the same row in one transaction is wasted WAL, and it makes
  // the optimistic version check meaningless.
  const netByAccount = new Map<string, Money>();
  for (const line of voucher.lines) {
    const row = byAccount.get(line.accountId)!;
    const amount = repo.toMoney(line.amount);
    const delta = signedDelta(line.drCr, amount, row.balanceSide);
    netByAccount.set(line.accountId, add(netByAccount.get(line.accountId) ?? money('0'), delta));
  }

  // Re-check availability against the CURRENT balance. Between creation and
  // approval, another voucher may have drained the account.
  for (const [accountId, net] of netByAccount) {
    const row = byAccount.get(accountId)!;
    if (compare(net, money('0')) >= 0) continue;

    const available = availableFrom(row);
    const required = negate(net);
    if (compare(available, required) < 0) {
      throw new BusinessRuleError(
        'INSUFFICIENT_FUNDS_AT_POSTING',
        `Account ${row.accountNumber} no longer has enough available. It has ${available}, the voucher needs ${required}.`,
        { accountNumber: row.accountNumber, available, required },
      );
    }
  }

  // Sorted so the UPDATEs go out in the same order the locks were taken.
  const ordered = [...netByAccount.entries()].sort(([a], [b]) => (a < b ? -1 : 1));

  const balanceAfterByAccount = new Map<string, Money>();

  for (const [accountId, net] of ordered) {
    const row = byAccount.get(accountId)!;
    const affected = await repo.applyBalanceDelta(accountId, net, row.version, tx);

    if (affected !== 1) {
      // The row is locked, so this should be unreachable. If it ever fires,
      // some path is updating balances without taking the lock -- which is
      // worth a loud, specific failure rather than a silent lost update.
      throw new ConcurrencyError('AccountBalance', accountId);
    }

    balanceAfterByAccount.set(accountId, add(money(row.ledgerBalance), net));
  }

  // Denormalised running balance, so a statement does not re-sum history.
  // Written per line after the fact, from the per-account result.
  for (const line of voucher.lines) {
    const after = balanceAfterByAccount.get(line.accountId);
    if (after) {
      await repo.setLineBalanceAfter(voucherId, line.lineNumber, voucher.postDate, after, tx);
    }
  }

  await tx.voucher.update({
    where: { id: voucherId },
    data: { status: 'POSTED', postedAt: new Date() },
  });

  await repo.addToBatchTotals(voucher.batchId, repo.toMoney(voucher.totalAmount), tx);

  // Business metric. "Postings dropped to zero at 10:04" is a better alert
  // than any infrastructure metric, because it fires for causes nobody
  // predicted -- which is exactly the class of incident the predicted alerts
  // miss.
  vouchersPosted.inc({ transaction_type: voucher.transactionType });

  await writeOutbox(tx, 'voucher.posted', voucherId, {
    voucherId,
    voucherNumber: voucher.voucherNumber,
    totalAmount: voucher.totalAmount.toString(),
    branchId: voucher.branchId,
    postDate: voucher.postDate.toISOString().slice(0, 10),
    accountIds,
  });

  log.info({ voucherId, accounts: accountIds.length }, 'voucher posted');
};

// ---------------------------------------------------------------------------
// Reversal
// ---------------------------------------------------------------------------

/**
 * Reverse a posted voucher.
 *
 * A correction is a NEW contra voucher that references the original. The
 * original is never edited and never deleted -- legacy `CanceledFlag` and
 * `ReverseVoucher`, and the only treatment an auditor accepts. The books must
 * show both that the mistake happened and that it was corrected.
 *
 * The reversal is itself subject to approval, because a reversal moves money
 * exactly as much as the original did.
 */
export const reverseVoucher = async (
  voucherId: string,
  reason: string,
  context: CreateVoucherContext,
): Promise<CreateVoucherResult> =>
  transaction(async (tx) => {
    const original = await repo.lockVoucherForUpdate(voucherId, tx);
    if (!original) throw new NotFoundError('Voucher', voucherId);

    if (original.status !== 'POSTED') {
      throw new BusinessRuleError(
        'VOUCHER_NOT_POSTED',
        `Only a posted voucher can be reversed. This one is ${original.status.toLowerCase()}.`,
      );
    }

    const full = await tx.voucher.findUniqueOrThrow({
      where: { id: voucherId },
      include: { lines: { orderBy: { lineNumber: 'asc' } } },
    });

    const existing = await tx.voucher.findUnique({ where: { reversalOfId: voucherId } });
    if (existing) {
      throw new BusinessRuleError(
        'ALREADY_REVERSED',
        `This voucher was already reversed by ${existing.voucherNumber}.`,
        { reversalVoucherNumber: existing.voucherNumber },
      );
    }

    const totalAmount = repo.toMoney(full.totalAmount);
    const requiredApprovals = await repo.findRequiredApprovals(
      context.branchId,
      full.transactionType,
      totalAmount,
      tx,
    );

    const voucherNumber = await repo.nextVoucherNumber(
      context.branchCode,
      context.workingDate,
      tx,
    );

    const reversal = await tx.voucher.create({
      data: {
        voucherNumber,
        branchId: context.branchId,
        batchId: context.batchId,
        transactionType: full.transactionType,
        status: 'PENDING_AUTH',
        entryDate: context.workingDate,
        postDate: context.workingDate,
        // Value date carries over from the original, so interest already
        // accrued is unwound over the same period rather than from today.
        valueDate: full.valueDate,
        totalAmount: full.totalAmount,
        narration: `Reversal of ${full.voucherNumber}: ${reason}`.slice(0, 140),
        makerId: context.actor.userId,
        requiredApprovals,
        reversalOfId: voucherId,
        reversalReason: reason,
      },
    });

    // Every leg flipped.
    await repo.insertVoucherLines(
      full.lines.map((line, index) => ({
        voucherId: reversal.id,
        postDate: context.workingDate,
        lineNumber: index + 1,
        accountId: line.accountId,
        drCr: (line.drCr === 'DEBIT' ? 'CREDIT' : 'DEBIT') as DrCr,
        amount: repo.toMoney(line.amount),
        valueDate: line.valueDate,
        narration: `Reversal of line ${line.lineNumber}`,
      })),
      tx,
    );

    await tx.voucher.update({ where: { id: voucherId }, data: { status: 'REVERSED' } });

    await writeOutbox(tx, 'voucher.reversal_created', reversal.id, {
      reversalId: reversal.id,
      originalId: voucherId,
      reason,
    });

    let status: string = 'PENDING_AUTH';
    if (requiredApprovals === 0) {
      await applyPosting(reversal.id, tx);
      status = 'POSTED';
    }

    log.info({ originalId: voucherId, reversalId: reversal.id, reason }, 'reversal created');

    return {
      voucherId: reversal.id,
      voucherNumber,
      status,
      requiredApprovals,
      approvalsGiven: 0,
      totalAmount,
    };
  });

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

/**
 * Write an event in the SAME transaction as the state change.
 *
 * This is the transactional outbox, and it is the highest-value pattern in the
 * whole build. Publishing to a queue inside the transaction announces things
 * that then roll back; publishing after commit loses events when the process
 * dies in between. There is no ordering of two separate systems that is safe.
 *
 * Writing to a table in the same transaction means the event and the state
 * change commit together or not at all, with no distributed transaction. A
 * relay (Phase 7) polls with `FOR UPDATE SKIP LOCKED` and publishes.
 *
 * The requestId travels with the event, so the worker's logs join the same
 * trace as the API call that caused it -- which is why AsyncLocalStorage was
 * set up back in Phase 3.
 */
const writeOutbox = async (
  tx: TxClient,
  eventType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<void> => {
  await tx.outboxEvent.create({
    data: {
      eventType,
      aggregateType: 'voucher',
      aggregateId,
      payload: payload as Prisma.InputJsonValue,
      requestId: getRequestId() ?? null,
    },
  });
};
