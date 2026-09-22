import type { Response } from 'express';
import { getRequestId } from '../logging/context';

/**
 * The response envelope.
 *
 * Every response, success or failure, has the same outer shape so clients have
 * exactly one thing to parse. `ok` is the discriminant, which makes the
 * TypeScript client side a discriminated union for free.
 *
 * `requestId` is echoed on every response. When a teller reports "it failed at
 * 11:04", that id is the entire investigation.
 */

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  meta?: Record<string, unknown>;
  requestId: string | undefined;
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  requestId: string | undefined;
}

export const ok = <T>(res: Response, data: T, meta?: Record<string, unknown>): Response => {
  const body: SuccessEnvelope<T> = { ok: true, data, requestId: getRequestId() };
  if (meta) body.meta = meta;
  return res.status(200).json(body);
};

export const created = <T>(res: Response, data: T, location?: string): Response => {
  if (location) res.setHeader('Location', location);
  const body: SuccessEnvelope<T> = { ok: true, data, requestId: getRequestId() };
  return res.status(201).json(body);
};

export const noContent = (res: Response): Response => res.status(204).send();

export const fail = (
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Response => {
  const body: ErrorEnvelope = {
    ok: false,
    error: details ? { code, message, details } : { code, message },
    requestId: getRequestId(),
  };
  return res.status(status).json(body);
};
