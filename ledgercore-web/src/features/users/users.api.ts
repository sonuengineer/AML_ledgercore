import { useInfiniteQuery, type UseInfiniteQueryResult, type InfiniteData } from '@tanstack/react-query';
import { apiGetResult } from '@/lib/api';
import type { PageMeta, UserStatus, UserSummary } from '@/types/api';

export interface UserPage {
  items: UserSummary[];
  meta: PageMeta;
}

export interface UserFilters {
  branchId?: string;
  status?: UserStatus;
}

export const userKeys = {
  list: (filters: UserFilters, limit: number) => ['users', 'list', filters, limit] as const,
};

const defaultMeta: PageMeta = { nextCursor: null, hasMore: false, limit: 0 };

/**
 * Keyset pagination.
 *
 * The server returns an opaque `meta.nextCursor` (base64 of the sort key
 * tuple), not a page number, and that is deliberate: OFFSET makes Postgres
 * read and discard every skipped row, and it lets a concurrent insert shift
 * the window so a user sees a duplicate or misses a record.
 *
 * The consequence for this UI is that there is no page 5 to jump to and no
 * total count to show -- a keyset cursor can only go forwards from where you
 * are. So the control is "Load more", never numbered pages. Anyone tempted to
 * add a page selector here has to change the server contract first.
 */
export const useUsers = (
  filters: UserFilters,
  limit = 20,
): UseInfiniteQueryResult<InfiniteData<UserPage, string | null>, Error> =>
  useInfiniteQuery<UserPage, Error, InfiniteData<UserPage, string | null>, ReturnType<typeof userKeys.list>, string | null>({
    queryKey: userKeys.list(filters, limit),
    initialPageParam: null,
    queryFn: async ({ pageParam }) => {
      const result = await apiGetResult<UserSummary[]>('/users', {
        limit,
        ...(pageParam ? { cursor: pageParam } : {}),
        ...filters,
      });
      return { items: result.data, meta: (result.meta as unknown as PageMeta) ?? defaultMeta };
    },
    getNextPageParam: (lastPage) => lastPage.meta.nextCursor,
    staleTime: 60_000,
  });
