import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import * as authApi from '@/features/auth/auth.api';
import { session } from '@/lib/session';
import type { MeResponse } from '@/types/api';

interface AuthState {
  user: MeResponse | null;
  /** Set on the login response; Phase 4 turns this into a forced redirect. */
  mustChangePassword: boolean;
  isAuthenticated: boolean;
  signIn: (staffCode: string, password: string) => Promise<void>;
  signOut: () => void;
  hasPermission: (permission: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export const AuthProvider = ({ children }: { children: ReactNode }): JSX.Element => {
  const [user, setUser] = useState<MeResponse | null>(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const reset = useCallback(() => {
    session.clear();
    setUser(null);
    setMustChangePassword(false);
    // Drop cached server state with the session: the next user of this tab
    // must not see the previous user's rows, even for a frame.
    queryClient.clear();
  }, [queryClient]);

  // The API client cannot import React, so it raises 401 through the session
  // module and this effect turns it into a route change.
  useEffect(
    () =>
      session.onUnauthorized(() => {
        reset();
        navigate('/login', { replace: true });
      }),
    [navigate, reset],
  );

  const signIn = useCallback(
    async (staffCode: string, password: string) => {
      const result = await authApi.login(staffCode, password);
      session.start(result.accessToken);

      // The login payload carries identity but not permissions. /auth/me is
      // the authority on those because it reads them fresh from the database,
      // so a revoked permission takes effect without re-issuing a token.
      const me = await authApi.fetchMe();
      session.setUser(me);
      setUser(me);
      setMustChangePassword(result.mustChangePassword);
    },
    [],
  );

  const signOut = useCallback(() => {
    reset();
    session.forgetHint();
    navigate('/login', { replace: true });
  }, [navigate, reset]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      mustChangePassword,
      isAuthenticated: user !== null,
      signIn,
      signOut,
      // Set lookup would be marginally faster; the list is ~10 entries, so the
      // extra structure to keep in sync is not worth it.
      hasPermission: (permission: string) => user?.permissions.includes(permission) ?? false,
    }),
    [user, mustChangePassword, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthState => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
};
