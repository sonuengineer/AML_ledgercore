import { Router } from 'express';
import { authRouter, userRouter } from '../modules/identity/identity.routes';
import { branchRouter } from '../modules/org/org.routes';
import { accountRouter, voucherRouter } from '../modules/ledger/ledger.routes';

/**
 * API v1.
 *
 * Versioned from day one. The legacy system had no versioning, so every change
 * to a hub method signature was a coordinated frontend/backend deploy -- which
 * is also why 38 hubs exist in two near-identical copies (WebAPI and
 * WebAPI.External): the only way to change a contract was to fork it.
 *
 * Routers are mounted, never individual routes. A new module is one line here.
 */
export const v1Router = Router();

v1Router.use('/auth', authRouter);
v1Router.use('/users', userRouter);
v1Router.use('/branches', branchRouter);
v1Router.use('/vouchers', voucherRouter);
v1Router.use('/accounts', accountRouter);
