import type { ReactNode } from 'react';
import { useAuth } from '@/features/auth/AuthProvider';

/**
 * Permission-aware rendering.
 *
 * READ THIS BEFORE USING IT: hiding a control is a user-experience decision,
 * not an authorisation decision. The server checks the same permission on the
 * route (see `authorize()` in the API) and will reject the call regardless of
 * what this component rendered.
 *
 * This is the exact mistake the legacy system made: per-group `.mnu` files on
 * each API server's disk carried Add/Modify/Delete/Inquire/Authorize flags,
 * those flags only drove what React rendered, and no hub method checked them.
 * Anyone who could craft a request had every permission. So: use `<Can>` to
 * keep the screen honest about what a user can do -- never as the control.
 */

export const usePermission = (permission: string): boolean => useAuth().hasPermission(permission);

/** True if the user holds at least one of the given permissions. */
export const useAnyPermission = (...permissions: string[]): boolean => {
  const { hasPermission } = useAuth();
  return permissions.some(hasPermission);
};

export const Can = ({
  permission,
  fallback = null,
  children,
}: {
  permission: string;
  fallback?: ReactNode;
  children: ReactNode;
}): JSX.Element | null => {
  const allowed = usePermission(permission);
  return <>{allowed ? children : fallback}</>;
};
