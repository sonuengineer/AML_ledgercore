import { Router } from 'express';
import { asyncHandler } from '../../shared/http/asyncHandler';
import { validate } from '../../shared/http/validate';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { idempotency } from '../../middleware/idempotency';
import { postingRateLimit } from '../../middleware/rateLimit';
import * as controller from './ledger.controller';

/**
 * Ledger routes.
 *
 * Read the middleware chain on each line and you have the control model:
 * who may call it, what shape the input must be, and whether a retry is safe.
 * The legacy .mnu files could answer none of those questions.
 */

export const voucherRouter = Router();

voucherRouter.use(authenticate);

// Idempotency is REQUIRED here, not optional. This is the endpoint that moves
// money; a client that has not thought about retries has not thought about
// this endpoint. Better a 400 telling them so than a double debit.
voucherRouter.post(
  '/',
  authorize('voucher:create'),
  // Per USER, not per IP: a whole branch sits behind one NAT address, so an
  // IP limit would throttle everyone because one teller is fast.
  postingRateLimit,
  idempotency({ required: true }),
  validate({ body: controller.createVoucherBodySchema }),
  asyncHandler(controller.createVoucher),
);

voucherRouter.get(
  '/',
  authorize('voucher:read'),
  validate({ query: controller.listVouchersQuerySchema }),
  asyncHandler(controller.listVouchers),
);

voucherRouter.get(
  '/:id',
  authorize('voucher:read'),
  validate({ params: controller.voucherIdParamSchema }),
  asyncHandler(controller.getVoucher),
);

// Approve and reject move money too, so they take an idempotency key as well.
voucherRouter.post(
  '/:id/approve',
  authorize('voucher:authorize'),
  idempotency(),
  validate({ params: controller.voucherIdParamSchema, body: controller.decisionBodySchema }),
  asyncHandler(controller.approveVoucher),
);

voucherRouter.post(
  '/:id/reject',
  authorize('voucher:authorize'),
  idempotency(),
  validate({ params: controller.voucherIdParamSchema, body: controller.rejectBodySchema }),
  asyncHandler(controller.rejectVoucher),
);

voucherRouter.post(
  '/:id/reverse',
  authorize('voucher:reverse'),
  idempotency({ required: true }),
  validate({ params: controller.voucherIdParamSchema, body: controller.reverseBodySchema }),
  asyncHandler(controller.reverseVoucher),
);

export const accountRouter = Router();

accountRouter.use(authenticate);

accountRouter.get(
  '/:accountId/balance',
  authorize('account:read'),
  validate({ params: controller.accountIdParamSchema }),
  asyncHandler(controller.getAvailableBalance),
);

accountRouter.get(
  '/:accountId/statement',
  authorize('account:read'),
  validate({ params: controller.accountIdParamSchema, query: controller.statementQuerySchema }),
  asyncHandler(controller.getStatement),
);
