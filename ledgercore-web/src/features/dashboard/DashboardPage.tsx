import { Link } from 'react-router-dom';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, Field } from '@/components/ui/card';
import { useAuth } from '@/features/auth/AuthProvider';
import { Can } from '@/features/auth/permissions';
import { BusinessDateCard } from '@/features/branches/BusinessDateCard';
import { PageHeader } from '@/layout/PageHeader';

export const DashboardPage = (): JSX.Element => {
  const { user, mustChangePassword } = useAuth();

  if (!user) return <PageHeader title="Dashboard" />;

  return (
    <div className="space-y-4">
      <PageHeader title="Dashboard" subtitle={`Signed in as ${user.displayName}`} />

      {mustChangePassword ? (
        <Alert tone="warn" title="Password change required">
          Your account is flagged for a password change. The change-password screen arrives in
          Phase 4; until then this is a notice only.
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Session" description="Identity comes from the token, never a form field" />
          <CardBody>
            <dl className="grid grid-cols-2 gap-4">
              <Field label="Staff code" value={<span className="font-mono">{user.staffCode}</span>} />
              <Field label="Name" value={user.displayName} />
              <Field label="Role" value={<Badge tone="info">{user.roleCode}</Badge>} />
              <Field
                label="Branch"
                value={
                  <Can
                    permission="branch:read"
                    fallback={<span className="font-mono">{user.branchCode}</span>}
                  >
                    <Link to={`/branches/${user.branchId}`} className="font-mono text-brand hover:underline">
                      {user.branchCode}
                    </Link>
                  </Can>
                }
              />
              <Field
                label="Multi-branch"
                value={user.multiBranchAccess ? 'Yes' : 'No -- home branch only'}
              />
              <Field label="Permissions held" value={String(user.permissions.length)} />
            </dl>
          </CardBody>
        </Card>

        <BusinessDateCard branchId={user.branchId} title="Your branch business date" />
      </div>

      <Card>
        <CardHeader
          title="Permissions"
          description="Sent by /auth/me so the UI can hide what you cannot do. The server enforces every one of these independently."
        />
        <CardBody>
          <ul className="flex flex-wrap gap-1.5">
            {user.permissions.map((permission) => (
              <li key={permission}>
                <span className="inline-flex rounded border border-line bg-raised px-2 py-0.5 font-mono text-xs text-ink">
                  {permission}
                </span>
              </li>
            ))}
          </ul>

          <p className="mt-3 text-xs text-muted">
            Hiding a control is a UX decision, not authorisation. The legacy system shipped
            per-group menu files that only drove rendering and were never checked server-side;
            here the same permission is enforced on the route.
          </p>
        </CardBody>
      </Card>
    </div>
  );
};
