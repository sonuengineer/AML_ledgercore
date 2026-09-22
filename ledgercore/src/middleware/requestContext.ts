import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { runWithContext, type RequestContext } from '../shared/logging/context';

/**
 * First middleware in the chain. Establishes the request id and opens the
 * AsyncLocalStorage scope that every later log line, SQL comment and queued
 * job will inherit.
 *
 * An inbound X-Request-Id is honoured so a trace survives the load balancer and
 * the frontend, but it is length-capped: it ends up in logs, and an unbounded
 * client-controlled string in a log line is a log-injection vector.
 */

const MAX_INBOUND_ID_LENGTH = 64;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;

const resolveRequestId = (header: unknown): string => {
  if (typeof header === 'string' && header.length > 0 && header.length <= MAX_INBOUND_ID_LENGTH && SAFE_ID.test(header)) {
    return header;
  }
  return randomUUID();
};

export const requestContext = (req: Request, res: Response, next: NextFunction): void => {
  const requestId = resolveRequestId(req.headers['x-request-id']);

  const context: RequestContext = {
    requestId,
    method: req.method,
    path: req.originalUrl,
    startedAt: Date.now(),
  };

  // Echo it back before anything can fail, so even a 500 carries the id.
  res.setHeader('X-Request-Id', requestId);
  // Purely diagnostic: lets an operator (and the Phase 8 proofs) see which
  // node answered. No client behaviour depends on it, and no client should
  // ever need it to -- that would be session affinity by the back door.
  res.setHeader('X-Instance-Id', config.instanceId);

  runWithContext(context, () => {
    next();
  });
};
