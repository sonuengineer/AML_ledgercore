import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import type { Branch, BusinessDate } from '@/types/api';

export const branchKeys = {
  all: ['branches'] as const,
  detail: (id: string) => ['branches', id] as const,
  businessDate: (id: string) => ['branches', id, 'business-date'] as const,
};

export const useBranches = (): UseQueryResult<Branch[]> =>
  useQuery({
    queryKey: branchKeys.all,
    queryFn: () => apiGet<Branch[]>('/branches'),
    // The branch master changes a few times a year. Refetching it on every
    // navigation would be a request per screen for data that is effectively
    // static within a session.
    staleTime: 15 * 60_000,
  });

export const useBranch = (id: string | undefined): UseQueryResult<Branch> =>
  useQuery({
    queryKey: branchKeys.detail(id ?? ''),
    queryFn: () => apiGet<Branch>(`/branches/${id}`),
    enabled: Boolean(id),
    staleTime: 15 * 60_000,
  });

/**
 * The branch's current business date.
 *
 * Fails with a 422 / DAY_NOT_OPEN when day begin has not been run. That is a
 * normal operational state, not an error, so callers must inspect the code and
 * render a warning rather than an error boundary -- and retrying it is
 * pointless because the answer will not change until an operator acts.
 */
export const useBusinessDate = (branchId: string | undefined): UseQueryResult<BusinessDate> =>
  useQuery({
    queryKey: branchKeys.businessDate(branchId ?? ''),
    queryFn: () => apiGet<BusinessDate>(`/branches/${branchId}/business-date/current`),
    enabled: Boolean(branchId),
    retry: false,
    staleTime: 60_000,
    // Rendered inline as a warning; the global toaster must not double up.
    meta: { silenceCodes: ['DAY_NOT_OPEN'] },
  });
