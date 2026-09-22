import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { pushError } from '@/components/ErrorToaster';
import { isApiError } from '@/lib/api';

/**
 * Server state policy.
 *
 * staleTime is per-query, chosen by how fast the data actually changes -- the
 * defaults here are the conservative floor. Retrying is off for anything the
 * server answered deliberately: a 403 or a 422 business-rule failure is not a
 * blip, and retrying it three times just triples the audit-log noise.
 */
const shouldRetry = (failureCount: number, error: unknown): boolean => {
  if (isApiError(error)) {
    if (error.isTransport) return failureCount < 2;
    // 4xx is the server stating a fact. Only 5xx and 429 are worth a retry.
    if (error.status < 500 && error.status !== 429) return false;
  }
  return failureCount < 2;
};

/**
 * Some failures are an expected operational state that the screen renders
 * itself (DAY_NOT_OPEN as a warning card, for one). A query declares those via
 * `meta: { silenceCodes: [...] }` so the global toaster does not shout about a
 * condition the user is already looking at. Opt-out is per code, never
 * blanket-per-status: an unhandled 422 should still surface.
 */
const isSilenced = (error: unknown, meta: Record<string, unknown> | undefined): boolean => {
  const codes = meta?.['silenceCodes'];
  return Array.isArray(codes) && isApiError(error) && codes.includes(error.code);
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: shouldRetry,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
  // Global surface: a failure is never silent, even if a screen forgets to
  // render its own error state.
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (!isSilenced(error, query.meta)) pushError(error);
    },
  }),
  mutationCache: new MutationCache({ onError: pushError }),
});
