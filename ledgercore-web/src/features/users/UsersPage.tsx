import { useMemo, useState } from 'react';
import { ErrorState } from '@/components/ErrorState';
import { Alert } from '@/components/ui/alert';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { LoadingRow, Spinner } from '@/components/ui/spinner';
import { EmptyRow, Table, Td, Th, Tr } from '@/components/ui/table';
import { usePermission } from '@/features/auth/permissions';
import { useUsers, type UserFilters } from '@/features/users/users.api';
import { isApiError } from '@/lib/api';
import { formatInstant } from '@/lib/format';
import { PageHeader } from '@/layout/PageHeader';
import type { UserStatus } from '@/types/api';

const STATUSES: Array<UserStatus | 'ALL'> = ['ALL', 'ACTIVE', 'LOCKED', 'DISABLED'];
const PAGE_SIZE = 5;

export const UsersPage = (): JSX.Element => {
  const [status, setStatus] = useState<UserStatus | 'ALL'>('ALL');

  const filters = useMemo<UserFilters>(
    () => (status === 'ALL' ? {} : { status }),
    [status],
  );

  // UX only: the query still fires for a user without the permission, and the
  // server still answers 403. We render the hint, not the enforcement.
  const canRead = usePermission('user:read');

  const { data, error, isPending, fetchNextPage, hasNextPage, isFetchingNextPage } = useUsers(
    filters,
    PAGE_SIZE,
  );

  const rows = data?.pages.flatMap((page) => page.items) ?? [];
  const forbidden = isApiError(error) && error.status === 403;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Users"
        subtitle="Staff accounts across the bank. Requires user:read."
        actions={
          <div className="flex items-center gap-1">
            {STATUSES.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={option === status ? 'primary' : 'secondary'}
                onClick={() => setStatus(option)}
              >
                {option}
              </Button>
            ))}
          </div>
        }
      />

      {forbidden ? (
        <Alert tone="warn" title="You do not have access to the user directory">
          <p>
            {error.message}
            {Array.isArray(error.details?.required)
              ? ` Required: ${(error.details.required as string[]).join(', ')}.`
              : null}
          </p>
          <p className="mt-2 text-xs text-muted">
            Tellers do not hold user:read. The menu entry stays visible on purpose -- the server,
            not this screen, decides what you may read.
            {error.requestId ? (
              <span className="ml-1 select-all font-mono">requestId: {error.requestId}</span>
            ) : null}
          </p>
        </Alert>
      ) : null}

      {error && !forbidden ? <ErrorState error={error} title="Could not load users" /> : null}

      {!canRead && !forbidden && !error ? (
        <Alert tone="info" title="Limited access">
          Your role does not list user:read, so this screen is expected to come back empty.
        </Alert>
      ) : null}

      <Card>
        <CardHeader
          title="Staff directory"
          description={rows.length > 0 ? `${rows.length} loaded` : undefined}
        />

        {isPending ? (
          <LoadingRow label="Loading users" />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th className="w-28">Staff code</Th>
                  <Th>Name</Th>
                  <Th className="w-36">Role</Th>
                  <Th className="w-28">Branch</Th>
                  <Th className="w-28">Status</Th>
                  <Th className="w-44">Last login</Th>
                </tr>
              </thead>
              <tbody>
                {rows.length > 0 ? (
                  rows.map((user) => (
                    <Tr key={user.id}>
                      <Td className="font-mono">{user.staffCode}</Td>
                      <Td className="font-medium">
                        {user.displayName}
                        {user.email ? (
                          <span className="ml-2 text-xs text-muted">{user.email}</span>
                        ) : null}
                      </Td>
                      <Td className="text-muted">{user.roleCode}</Td>
                      <Td className="font-mono text-muted">{user.branchCode}</Td>
                      <Td>
                        <StatusBadge status={user.status} />
                      </Td>
                      <Td className="text-muted">{formatInstant(user.lastLoginAt)}</Td>
                    </Tr>
                  ))
                ) : (
                  <EmptyRow colSpan={6}>
                    {forbidden ? 'Nothing to show for your role.' : 'No users match this filter.'}
                  </EmptyRow>
                )}
              </tbody>
            </Table>

            {/* No page numbers by design -- see the comment in users.api.ts. */}
            {rows.length > 0 ? (
              <div className="flex items-center justify-between border-t border-line px-4 py-3">
                <span className="text-xs text-muted">
                  {hasNextPage
                    ? `Showing ${rows.length}. Keyset pagination has no page count.`
                    : `End of list -- ${rows.length} users.`}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!hasNextPage || isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                >
                  {isFetchingNextPage ? <Spinner /> : null}
                  {hasNextPage ? 'Load more' : 'No more'}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
};
