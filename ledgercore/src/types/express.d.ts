import type { Actor } from '../modules/identity/identity.service';

/**
 * `req.actor` is set by the authenticate middleware and is the ONLY place a
 * handler may read the caller's identity from.
 *
 * It is optional in the type because anonymous routes exist. Handlers behind
 * `authenticate` use the `requireActor(req)` helper, which narrows it and
 * throws if the middleware was not wired -- a wiring mistake then fails loudly
 * at the first request instead of silently serving an unauthenticated caller.
 */
declare global {
  namespace Express {
    interface Request {
      actor?: Actor;
    }
  }
}

export {};
