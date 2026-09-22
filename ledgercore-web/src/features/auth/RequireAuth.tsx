import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthProvider';

/**
 * Route guard.
 *
 * There is no "restoring session" state to wait on: the access token lives in
 * memory (see session.ts), so on a fresh page load the user is simply not
 * authenticated and the login screen renders immediately -- no flash of the
 * shell, no spinner that resolves to a redirect. Phase 4's refresh cookie will
 * add a genuine bootstrap step here.
 */
export const RequireAuth = (): JSX.Element => {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    // `from` lets the login screen send the user back where they were headed.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
};
