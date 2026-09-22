import { NavLink, Outlet } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/auth/AuthProvider';
import { useBusinessDate } from '@/features/branches/branches.api';
import { isApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBusinessDate } from '@/lib/format';

interface NavItem {
  to: string;
  label: string;
  /** Permission the screen needs. Informational: the route is not blocked on
   *  it, because the server is the gate and a stale permission list here must
   *  never be the reason a user cannot reach a page they are entitled to. */
  permission?: string;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/branches', label: 'Branches', permission: 'branch:read' },
  { to: '/users', label: 'Users', permission: 'user:read' },
];

/** Compact read-out of the signed-in user's own branch working date. */
const BusinessDateChip = (): JSX.Element => {
  const { user } = useAuth();
  const { data, error, isPending } = useBusinessDate(user?.branchId);

  if (isPending) return <span className="text-xs text-muted">Business date ...</span>;

  if (isApiError(error) && error.code === 'DAY_NOT_OPEN') {
    return <Badge tone="warn">Day not open</Badge>;
  }

  if (!data) return <Badge tone="neutral">Date unavailable</Badge>;

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted">Business date</span>
      <span className="font-mono text-sm text-ink">{formatBusinessDate(data.workingDate)}</span>
      <Badge tone={data.status === 'OPEN' ? 'ok' : 'warn'}>{data.status}</Badge>
    </div>
  );
};

export const AppShell = (): JSX.Element => {
  const { user, signOut, hasPermission } = useAuth();

  return (
    <div className="flex min-h-screen bg-canvas text-ink">
      <aside className="hidden w-52 shrink-0 border-r border-line bg-surface md:block">
        <div className="border-b border-line px-4 py-4">
          <p className="text-sm font-semibold tracking-tight">LedgerCore</p>
          <p className="text-[11px] text-muted">Back office</p>
        </div>
        <nav className="p-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center justify-between rounded px-3 py-2 text-sm',
                  isActive ? 'bg-brand/10 font-medium text-brand' : 'text-ink hover:bg-raised',
                )
              }
            >
              <span>{item.label}</span>
              {/* A dimmed entry tells the user the screen exists but is not
                  theirs, instead of silently vanishing the navigation. */}
              {item.permission && !hasPermission(item.permission) ? (
                <span className="text-[10px] uppercase text-muted">n/a</span>
              ) : null}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3">
          <BusinessDateChip />

          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-sm font-medium leading-tight">{user?.displayName}</p>
              <p className="text-[11px] text-muted">
                {user?.staffCode} / {user?.roleCode} / Branch {user?.branchCode}
              </p>
            </div>
            {user?.multiBranchAccess ? <Badge tone="info">Multi-branch</Badge> : null}
            <Button size="sm" variant="secondary" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </header>

        <main className="min-w-0 flex-1 p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
};
