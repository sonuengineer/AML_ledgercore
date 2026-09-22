import { Router } from 'express';
import { asyncHandler } from '../../shared/http/asyncHandler';
import { validate } from '../../shared/http/validate';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import * as controller from './org.controller';

/**
 * Organisation routes.
 *
 * Every route states its middleware chain explicitly rather than inheriting a
 * global `app.use(authenticate)`. Reading the file tells you, per endpoint,
 * who may call it -- which is exactly what an auditor asks for, and exactly
 * what the legacy `.mnu` files could not answer.
 */

export const branchRouter = Router();

branchRouter.use(authenticate);

branchRouter.get(
  '/',
  authorize('branch:read'),
  validate({ query: controller.listBranchesQuerySchema }),
  asyncHandler(controller.listBranches),
);

branchRouter.get(
  '/:id',
  authorize('branch:read'),
  validate({ params: controller.branchIdParamSchema }),
  asyncHandler(controller.getBranch),
);

branchRouter.get(
  '/:id/business-date/current',
  authorize('branch:read'),
  validate({ params: controller.branchIdParamSchema }),
  asyncHandler(controller.getCurrentBusinessDate),
);
