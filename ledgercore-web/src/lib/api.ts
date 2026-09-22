import axios, { AxiosError, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { session } from '@/lib/session';
import type { ErrorEnvelope, SuccessEnvelope } from '@/types/api';

/**
 * The single door to the API.
 *
 * Four jobs, and nothing else belongs here:
 *   1. attach the bearer token,
 *   2. carry a request id in both directions,
 *   3. unwrap the success envelope so callers never see `.data.data`,
 *   4. turn the failure envelope into one typed exception.
 *
 * Every feature module calls through this file. A component that reaches for
 * `fetch` directly is a bug, because it skips all four.
 */

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000/api/v1';

/** Matches the server's inbound id validation: <= 64 chars of [A-Za-z0-9._:-]. */
const newRequestId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Non-secure-context fallback. Correlation only, never a security boundary.
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

/**
 * Every failure the UI can see, in one shape.
 *
 * `code` is the stable contract (`DAY_NOT_OPEN`, `FORBIDDEN`, ...); `message`
 * is wording that may change, so never branch on it. `requestId` is what a
 * teller quotes to support -- it is the whole investigation, so it is surfaced
 * in the UI rather than only logged.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly details: Record<string, unknown> | undefined;

  constructor(init: {
    code: string;
    message: string;
    status: number;
    requestId: string | null;
    details?: Record<string, unknown>;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId;
    this.details = init.details;
  }

  /** Status 0 means the request never reached the API (offline, CORS, DNS). */
  get isTransport(): boolean {
    return this.status === 0;
  }
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError;

const http = axios.create({
  baseURL: BASE_URL,
  timeout: 20_000,
  headers: { 'Content-Type': 'application/json' },
});

http.interceptors.request.use((config) => {
  config.headers.set('X-Request-Id', newRequestId());

  const token = session.getToken();
  if (token) config.headers.set('Authorization', `Bearer ${token}`);

  return config;
});

const isErrorEnvelope = (body: unknown): body is ErrorEnvelope =>
  typeof body === 'object' && body !== null && (body as ErrorEnvelope).ok === false;

/** A 401 on the login call is "wrong password", not "session expired". */
const isLoginAttempt = (config: AxiosRequestConfig | undefined): boolean =>
  (config?.url ?? '').includes('/auth/login');

http.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (!(error instanceof AxiosError)) {
      return Promise.reject(
        new ApiError({ code: 'CLIENT_ERROR', message: String(error), status: 0, requestId: null }),
      );
    }

    const response = error.response;

    if (!response) {
      return Promise.reject(
        new ApiError({
          code: error.code === 'ECONNABORTED' ? 'TIMEOUT' : 'NETWORK_ERROR',
          message:
            error.code === 'ECONNABORTED'
              ? 'The server took too long to respond.'
              : 'Could not reach the LedgerCore API.',
          status: 0,
          requestId: null,
        }),
      );
    }

    // Prefer the header: it is set before routing, so it survives a failure
    // that never produced an envelope (a 502 from a proxy, a crash).
    const headerId = response.headers['x-request-id'];
    const body: unknown = response.data;

    const requestId =
      (isErrorEnvelope(body) ? body.requestId : null) ??
      (typeof headerId === 'string' ? headerId : null);

    if (response.status === 401 && !isLoginAttempt(error.config)) {
      // The token is gone or the account changed underneath us. Drop the
      // session before the redirect so nothing re-fires with a dead token.
      session.notifyUnauthorized();
    }

    const apiError = isErrorEnvelope(body)
      ? new ApiError({
          code: body.error.code,
          message: body.error.message,
          status: response.status,
          requestId,
          ...(body.error.details ? { details: body.error.details } : {}),
        })
      : new ApiError({
          code: 'UNEXPECTED_RESPONSE',
          message: `Unexpected ${response.status} response from the API.`,
          status: response.status,
          requestId,
        });

    return Promise.reject(apiError);
  },
);

/** Full result, for the callers that need `meta` (keyset pagination). */
export interface ApiResult<T> {
  data: T;
  meta: Record<string, unknown> | undefined;
  requestId: string | null;
}

const toResult = <T>(response: AxiosResponse<SuccessEnvelope<T>>): ApiResult<T> => {
  const body = response.data;

  // A 2xx that is not an envelope means we are talking to something that is
  // not this API (a captive portal, a stale proxy). Fail loudly rather than
  // handing components `undefined`.
  if (typeof body !== 'object' || body === null || body.ok !== true) {
    throw new ApiError({
      code: 'UNEXPECTED_RESPONSE',
      message: 'The API returned a body that is not a LedgerCore envelope.',
      status: response.status,
      requestId: null,
    });
  }

  return { data: body.data, meta: body.meta, requestId: body.requestId };
};

export const apiGetResult = async <T>(
  url: string,
  params?: Record<string, unknown>,
): Promise<ApiResult<T>> =>
  toResult<T>(await http.get<SuccessEnvelope<T>>(url, params ? { params } : undefined));

export const apiGet = async <T>(url: string, params?: Record<string, unknown>): Promise<T> =>
  (await apiGetResult<T>(url, params)).data;

export const apiPost = async <T>(url: string, body?: unknown): Promise<T> =>
  toResult<T>(await http.post<SuccessEnvelope<T>>(url, body)).data;

export { http as apiClient, BASE_URL as apiBaseUrl };
