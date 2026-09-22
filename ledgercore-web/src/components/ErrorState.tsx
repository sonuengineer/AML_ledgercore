import { Alert } from '@/components/ui/alert';
import { isApiError } from '@/lib/api';

/**
 * The one place a failure is rendered.
 *
 * It always shows `error.code` and `requestId`. The message is for the user;
 * the code is what a developer greps for; the request id is what ties the
 * user's screenshot to the exact server log line. Omitting the id is what
 * turns "it failed at 11:04" into an afternoon of log archaeology.
 */
export const ErrorState = ({
  error,
  title = 'Something went wrong',
}: {
  error: unknown;
  title?: string;
}): JSX.Element => {
  const api = isApiError(error) ? error : null;
  const message = api?.message ?? (error instanceof Error ? error.message : 'Unknown error');

  return (
    <Alert tone="danger" title={title}>
      <p>{message}</p>
      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-muted">
        {api ? (
          <div className="flex gap-1">
            <dt>code</dt>
            <dd className="text-ink">{api.code}</dd>
          </div>
        ) : null}
        {api && api.status > 0 ? (
          <div className="flex gap-1">
            <dt>status</dt>
            <dd className="text-ink">{api.status}</dd>
          </div>
        ) : null}
        {api?.requestId ? (
          <div className="flex gap-1">
            <dt>requestId</dt>
            <dd className="select-all text-ink">{api.requestId}</dd>
          </div>
        ) : null}
      </dl>
    </Alert>
  );
};
