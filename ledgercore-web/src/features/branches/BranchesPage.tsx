import { useNavigate } from 'react-router-dom';
import { ErrorState } from '@/components/ErrorState';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyRow, Table, Td, Th, Tr } from '@/components/ui/table';
import { LoadingRow } from '@/components/ui/spinner';
import { useBranches } from '@/features/branches/branches.api';
import { formatCalendarDate } from '@/lib/format';
import { PageHeader } from '@/layout/PageHeader';

export const BranchesPage = (): JSX.Element => {
  const navigate = useNavigate();
  const { data, error, isPending } = useBranches();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Branches"
        subtitle="Requires branch:read. A single-branch user can list branches but may only open their own."
      />

      {error ? <ErrorState error={error} title="Could not load branches" /> : null}

      <Card>
        <CardHeader title="Branch master" description={data ? `${data.length} branches` : undefined} />
        {isPending ? (
          <LoadingRow label="Loading branches" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="w-24">Code</Th>
                <Th>Name</Th>
                <Th className="w-32">Status</Th>
                <Th className="w-40">Opened on</Th>
              </tr>
            </thead>
            <tbody>
              {data && data.length > 0 ? (
                data.map((branch) => (
                  <Tr key={branch.id} interactive onClick={() => navigate(`/branches/${branch.id}`)}>
                    <Td className="font-mono">{branch.code}</Td>
                    <Td className="font-medium">{branch.name}</Td>
                    <Td>
                      <StatusBadge status={branch.status} />
                    </Td>
                    <Td className="text-muted">{formatCalendarDate(branch.openedOn)}</Td>
                  </Tr>
                ))
              ) : (
                <EmptyRow colSpan={4}>No branches to show.</EmptyRow>
              )}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
};
