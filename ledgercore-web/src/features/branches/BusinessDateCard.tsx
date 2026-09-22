import { Alert } from '@/components/ui/alert';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, Field } from '@/components/ui/card';
import { LoadingRow } from '@/components/ui/spinner';
import { ErrorState } from '@/components/ErrorState';
import { useBusinessDate } from '@/features/branches/branches.api';
import { isApiError } from '@/lib/api';
import { formatBusinessDate, formatInstant } from '@/lib/format';

/**
 * DAY_NOT_OPEN is an expected branch state -- seed branch 103 is deliberately
 * left without an open day. It arrives as a 422, so it must be pulled out of
 * the error path by code and rendered as a warning; letting it reach the
 * generic error surface would tell an operator their software is broken when
 * in fact they simply have not run day begin.
 */
export const BusinessDateCard = ({
  branchId,
  title = 'Business date',
}: {
  branchId: string | undefined;
  title?: string;
}): JSX.Element => {
  const { data, error, isPending } = useBusinessDate(branchId);

  const dayNotOpen = isApiError(error) && error.code === 'DAY_NOT_OPEN';

  return (
    <Card>
      <CardHeader title={title} description="Governs the value date of every posting" />
      <CardBody>
        {isPending ? <LoadingRow label="Reading business date" /> : null}

        {dayNotOpen ? (
          <Alert tone="warn" title="Day not open">
            {error.message} Postings are blocked for this branch until an operator runs day begin.
          </Alert>
        ) : null}

        {error && !dayNotOpen ? <ErrorState error={error} title="Business date unavailable" /> : null}

        {data ? (
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Field label="Working date" value={formatBusinessDate(data.workingDate)} />
            <Field label="Status" value={<StatusBadge status={data.status} />} />
            <Field label="Opened" value={formatInstant(data.openedAt)} />
            <Field label="Closed" value={formatInstant(data.closedAt)} />
          </dl>
        ) : null}
      </CardBody>
    </Card>
  );
};
