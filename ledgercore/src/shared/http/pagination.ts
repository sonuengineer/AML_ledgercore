import { z } from 'zod';
import { ValidationError } from '../errors/AppError';

/**
 * Keyset (cursor) pagination.
 *
 * Why not OFFSET: `OFFSET 50000` makes Postgres read and discard 50,000 rows.
 * On the tables this system will grow -- voucher_line, audit_event, the
 * authorisation queue -- that turns page 500 into a table scan. Keyset
 * pagination stays O(page size) at any depth because it is an index seek.
 *
 * It also fixes a correctness problem nobody notices until production: with
 * OFFSET, a row inserted while a user pages through makes them see a duplicate
 * or skip a row. Keyset is stable against concurrent inserts.
 *
 * The cursor is opaque to the client on purpose -- it is base64 of the sort key
 * tuple, so its shape can change without breaking anyone.
 */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** The sort key. Composite so it is unique -- a timestamp alone is not. */
export interface Cursor {
  createdAt: string;
  id: string;
}

export const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

export const decodeCursor = (raw: string | undefined): Cursor | undefined => {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('malformed cursor payload');
    }
    return parsed;
  } catch {
    throw new ValidationError('Invalid pagination cursor');
  }
};

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Take `limit + 1` rows from the repository, pass them here. The extra row is
 * how we know there is a next page without a second COUNT query -- and a
 * COUNT(*) on a large table is exactly the query that shows up in a slow log.
 */
export const buildPage = <T extends { id: string; createdAt: Date }>(
  rows: T[],
  limit: number,
): Page<T> => {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
  };
};
