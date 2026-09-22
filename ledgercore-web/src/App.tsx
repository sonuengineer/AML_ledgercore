import { Link, Route, Routes } from 'react-router-dom';
import { ErrorToaster } from '@/components/ErrorToaster';
import { AuthProvider } from '@/features/auth/AuthProvider';
import { LoginPage } from '@/features/auth/LoginPage';
import { RequireAuth } from '@/features/auth/RequireAuth';
import { BranchDetailPage } from '@/features/branches/BranchDetailPage';
import { BranchesPage } from '@/features/branches/BranchesPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { UsersPage } from '@/features/users/UsersPage';
import { AppShell } from '@/layout/AppShell';

const NotFound = (): JSX.Element => (
  <div className="space-y-2">
    <h1 className="text-base font-semibold">Page not found</h1>
    <Link to="/" className="text-sm text-brand hover:underline">
      Back to the dashboard
    </Link>
  </div>
);

// AuthProvider sits inside the router because it navigates on sign-out and on
// the 401 the API client raises.
export const App = (): JSX.Element => (
  <AuthProvider>
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="branches" element={<BranchesPage />} />
          <Route path="branches/:id" element={<BranchDetailPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>

    <ErrorToaster />
  </AuthProvider>
);
