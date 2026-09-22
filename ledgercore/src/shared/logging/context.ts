import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context, carried implicitly through the call stack.
 *
 * Why AsyncLocalStorage and not a parameter: the requestId has to reach the
 * logger inside a repository five frames down, and threading a `ctx` argument
 * through every signature pollutes the domain layer with transport concerns.
 * ALS gives ambient context without that cost.
 *
 * Phase 7 note: when a request enqueues a job, the requestId is copied into the
 * job payload so the worker's logs join the same trace. That is the whole
 * reason this exists now rather than later.
 */

export interface RequestContext {
  requestId: string;
  /** Populated by the authenticate middleware, absent on anonymous routes. */
  userId?: string;
  staffCode?: string;
  branchId?: string;
  roleCode?: string;
  method: string;
  path: string;
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithContext = <T>(context: RequestContext, fn: () => T): T =>
  storage.run(context, fn);

export const getContext = (): RequestContext | undefined => storage.getStore();

export const getRequestId = (): string | undefined => storage.getStore()?.requestId;

/**
 * Mutates the active context. Used by `authenticate` once the token is
 * verified, so every log line after that point carries the actor.
 */
export const enrichContext = (patch: Partial<RequestContext>): void => {
  const current = storage.getStore();
  if (current) Object.assign(current, patch);
};
