import { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { FieldError, Input, Label } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/AuthProvider';
import { isApiError } from '@/lib/api';
import { session } from '@/lib/session';

// Mirrors the server's loginBodySchema. Client validation is a latency
// optimisation only -- the server re-validates and is the authority.
const loginSchema = z.object({
  staffCode: z.string().trim().min(1, 'Staff code is required').max(16),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

type LoginForm = z.infer<typeof loginSchema>;

export const LoginPage = (): JSX.Element => {
  const { isAuthenticated, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [formError, setFormError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);

  // Read once on mount: the hint is cleared as soon as it is shown, so it does
  // not reappear after a deliberate sign-out.
  const [expired] = useState(() => session.hadSession());
  useEffect(() => {
    if (expired) session.forgetHint();
  }, [expired]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { staffCode: '', password: '' },
  });

  if (isAuthenticated) return <Navigate to="/" replace />;

  const redirectTo = (location.state as { from?: string } | null)?.from ?? '/';

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    setRequestId(null);
    try {
      await signIn(values.staffCode, values.password);
      navigate(redirectTo, { replace: true });
    } catch (error) {
      // The API returns one message for unknown staff code, wrong password and
      // locked account on purpose -- distinguishing them is a user-enumeration
      // oracle. Do not try to be more helpful here than the server was.
      setFormError(isApiError(error) ? error.message : 'Sign in failed. Try again.');
      setRequestId(isApiError(error) ? error.requestId : null);
    }
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold tracking-tight text-ink">LedgerCore</h1>
          <p className="mt-1 text-xs text-muted">Back-office console</p>
        </div>

        <Card>
          <CardBody className="space-y-4 p-5">
            {expired ? (
              <Alert tone="info" title="Signed out">
                Your session ended -- the access token expired, or a reload dropped it. Sign in
                again.
              </Alert>
            ) : null}

            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              <div>
                <Label htmlFor="staffCode">Staff code</Label>
                <Input
                  id="staffCode"
                  autoComplete="username"
                  autoFocus
                  spellCheck={false}
                  placeholder="T001"
                  invalid={Boolean(errors.staffCode)}
                  {...register('staffCode')}
                />
                <FieldError>{errors.staffCode?.message}</FieldError>
              </div>

              <div>
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  invalid={Boolean(errors.password)}
                  {...register('password')}
                />
                <FieldError>{errors.password?.message}</FieldError>
              </div>

              {formError ? (
                <Alert tone="danger" title="Sign in failed">
                  <p>{formError}</p>
                  {requestId ? (
                    <p className="mt-1 select-all font-mono text-[11px] text-muted">
                      requestId: {requestId}
                    </p>
                  ) : null}
                </Alert>
              ) : null}

              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? <Spinner className="border-brand-ink/40 border-t-brand-ink" /> : null}
                {isSubmitting ? 'Signing in' : 'Sign in'}
              </Button>
            </form>
          </CardBody>
        </Card>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-muted">
          The access token is held in memory only. Closing or reloading this tab ends the session.
        </p>
      </div>
    </div>
  );
};
