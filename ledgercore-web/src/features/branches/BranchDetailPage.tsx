import { Link, useParams } from 'react-router-dom';
import { ErrorState } from '@/components/ErrorState';
import { StatusBadge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader, Field } from '@/components/ui/card';
import { LoadingRow } from '@/components/ui/spinner';
import { BusinessDateCard } from '@/features/branches/BusinessDateCard';
import { useBranch } from '@/features/branches/branches.api';
import { isApiError } from '@/lib/api';
import { formatCalendarDate } from '@/lib/format';
import { PageHeader } from '@/layout/PageHeader';

export const BranchDetailPage = (): JSX.Element => {
  const { id } = useParams<{ id: string }>();
  const { data, error, isPending } = useBranch(id);

  // Branch scoping is enforced server-side: a single-branch user reading
  // another branch's id out of the URL gets a 403, not data.
  const crossBranch = isApiError(error) && error.status === 403;

  return (
    <div className="space-y-4">
      <PageHeader
        title={data ? `Branch ${data.code} -- ${data.name}` : 'Branch'}
        subtitle={<Link to="/branches" className="text-brand hover:underline">Back to branches</Link>}
      />

      {crossBranch ? (
        <Alert tone="warn" title="Outside your branch">
          {error.message} Only users with multi-branch access may open another branch.
        </Alert>
      ) : null}

      {error && !crossBranch ? <ErrorState error={error} title="Could not load branch" /> : null}

      <Card>
        <CardHeader title="Branch" />
        <CardBody>
          {isPending ? <LoadingRow /> : null}
          {data ? (
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Field label="Code" value={<span className="font-mono">{data.code}</span>} />
              <Field label="Name" value={data.name} />
              <Field label="Status" value={<StatusBadge status={data.status} />} />
              <Field label="Opened on" value={formatCalendarDate(data.openedOn)} />
            </dl>
          ) : null}
        </CardBody>
      </Card>

      {/* Only ask for the business date once the branch itself is readable --
          otherwise a 403 branch produces two identical forbidden errors. */}
      {data ? <BusinessDateCard branchId={data.id} /> : null}
    </div>
  );
};
