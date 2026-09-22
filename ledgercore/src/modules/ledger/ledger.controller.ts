import type { Request, Response } from 'express';
import { z } from 'zod';
import { created, ok } from '../../shared/http/respond';
import { paginationQuerySchema } from '../../shared/http/pagination';
import { requireActor } from '../../middleware/authenticate';
import { assertBranchAccess } from '../../middleware/authorize';
import { money } from '../../shared/money/money';
import * as service from './ledger.service';
import type { CreateVoucherCommand } from './ledger.types';

/**
 * Money arrives as a string and is parsed by `money()`, which rejects anything
 * that is not an exact decimal. A JSON number would already have been through
 * IEEE-754 by the time it reached us -- `1234.56` survives, `0.1 + 0.2` does
 * not, and there is no way to tell afterwards which happened.
 */
const moneySchema = z
  .string()
  .refine((value) => {
    try {
      money(value);
      return true;
    } catch {
      return false;
    }
  }, 'Must be a decimal amount as a string, e.g. "1500.00"');

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be an ISO date (YYYY-MM-DD)');

export const createVoucherBodySchema = z.object({
  transactionType: z.enum(['CASH', 'TRANSFER', 'CLEARING']),
  narration: z.string().trim().min(1).max(140),
  valueDate: isoDateSchema.optional(),
  instrumentNumber: z.string().trim().max(20).optional(),
  instrumentDate: isoDateSchema.optional(),
  lines: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        drCr: z.enum(['DEBIT', 'CREDIT']),
        amount: moneySchema,
        narration: z.string().trim().max(140).optional(),
        valueDate: isoDateSchema.optional(),
      }),
    )
    // Two is the minimum for double entry. Fifty is a practical ceiling that
    // keeps one request from locking an unbounded number of balance rows --
    // an unbounded voucher is a denial-of-service on the posting path.
    .min(2)
    .max(50),
});

export const voucherIdParamSchema = z.object({ id: z.string().uuid() });

export const decisionBodySchema = z.object({
  remarks: z.string().trim().max(140).optional(),
});

export const rejectBodySchema = z.object({
  remarks: z.string().trim().min(1, 'A rejection must say why').max(140),
});

export const reverseBodySchema = z.object({
  reason: z.string().trim().min(1, 'A reversal must say why').max(140),
});

export const listVouchersQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['PENDING_AUTH', 'POSTED', 'REJECTED', 'REVERSED']).optional(),
});

export const statementQuerySchema = z.object({
  fromDate: isoDateSchema,
  toDate: isoDateSchema,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export const accountIdParamSchema = z.object({ accountId: z.string().uuid() });

export const createVoucher = async (req: Request, res: Response): Promise<void> => {
  const actor = requireActor(req);
  const body = req.body as z.infer<typeof createVoucherBodySchema>;

  const command: CreateVoucherCommand = {
    transactionType: body.transactionType,
    narration: body.narration,
    ...(body.valueDate ? { valueDate: body.valueDate } : {}),
    ...(body.instrumentNumber ? { instrumentNumber: body.instrumentNumber } : {}),
    ...(body.instrumentDate ? { instrumentDate: body.instrumentDate } : {}),
    lines: body.lines.map((line) => ({
      accountId: line.accountId,
      drCr: line.drCr,
      amount: money(line.amount),
      ...(line.narration ? { narration: line.narration } : {}),
      ...(line.valueDate ? { valueDate: line.valueDate } : {}),
    })),
  };

  const result = await service.createVoucher(command, actor);
  created(res, result, `/api/v1/vouchers/${result.voucherId}`);
};

export const getVoucher = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as z.infer<typeof voucherIdParamSchema>;
  const voucher = await service.getVoucher(id);
  assertBranchAccess(req, voucher.branchId);
  ok(res, voucher);
};

export const listVouchers = async (req: Request, res: Response): Promise<void> => {
  const actor = requireActor(req);
  const query = req.query as unknown as z.infer<typeof listVouchersQuerySchema>;

  const page = await service.listVouchers({
    branchId: actor.branchId,
    ...(query.status ? { status: query.status } : {}),
    limit: query.limit,
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });

  ok(res, page.items, { nextCursor: page.nextCursor, hasMore: page.hasMore, limit: query.limit });
};

export const approveVoucher = async (req: Request, res: Response): Promise<void> => {
  const actor = requireActor(req);
  const { id } = req.params as z.infer<typeof voucherIdParamSchema>;
  const { remarks } = req.body as z.infer<typeof decisionBodySchema>;
  ok(res, await service.approveVoucher(id, actor, remarks));
};

export const rejectVoucher = async (req: Request, res: Response): Promise<void> => {
  const actor = requireActor(req);
  const { id } = req.params as z.infer<typeof voucherIdParamSchema>;
  const { remarks } = req.body as z.infer<typeof rejectBodySchema>;
  ok(res, await service.rejectVoucher(id, actor, remarks));
};

export const reverseVoucher = async (req: Request, res: Response): Promise<void> => {
  const actor = requireActor(req);
  const { id } = req.params as z.infer<typeof voucherIdParamSchema>;
  const { reason } = req.body as z.infer<typeof reverseBodySchema>;
  const result = await service.reverseVoucher(id, reason, actor);
  created(res, result, `/api/v1/vouchers/${result.voucherId}`);
};

export const getAvailableBalance = async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params as z.infer<typeof accountIdParamSchema>;
  ok(res, await service.getAvailableBalance(accountId));
};

export const getStatement = async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params as z.infer<typeof accountIdParamSchema>;
  const query = req.query as unknown as z.infer<typeof statementQuerySchema>;

  ok(
    res,
    await service.getStatement({
      accountId,
      fromDate: new Date(query.fromDate),
      toDate: new Date(query.toDate),
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    }),
  );
};
