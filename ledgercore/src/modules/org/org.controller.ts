import type { Request, Response } from 'express';
import { z } from 'zod';
import { ok } from '../../shared/http/respond';
import { assertBranchAccess } from '../../middleware/authorize';
import * as service from './org.service';

/**
 * Controllers do three things and nothing else:
 *   1. pull already-validated input off the request,
 *   2. call one service method,
 *   3. shape the response.
 *
 * No business rules, no data access, no try/catch -- `asyncHandler` routes
 * rejections to the error middleware.
 */

export const branchIdParamSchema = z.object({
  id: z.string().uuid('Branch id must be a UUID'),
});

export const listBranchesQuerySchema = z.object({
  bankId: z.string().uuid().optional(),
});

export const listBranches = async (req: Request, res: Response): Promise<void> => {
  const { bankId } = req.query as z.infer<typeof listBranchesQuerySchema>;
  const branches = await service.listBranches(bankId);
  ok(res, branches, { count: branches.length });
};

export const getBranch = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as z.infer<typeof branchIdParamSchema>;
  // Authorisation is not just "has the permission" -- it is also "for which
  // branch". The legacy system could not make this check at all, because the
  // branch code arrived in the request body.
  assertBranchAccess(req, id);
  ok(res, await service.getBranch(id));
};

export const getCurrentBusinessDate = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as z.infer<typeof branchIdParamSchema>;
  assertBranchAccess(req, id);
  ok(res, await service.getCurrentBusinessDate(id));
};
