import { useEffect, useSyncExternalStore } from 'react';
import { isApiError } from '@/lib/api';

/**
 * Global error surface.
 *
 * Every query/mutation failure that TanStack Query reports lands here (see
 * queryClient.ts), so a failure is never silent even on a screen that forgot
 * to render an inline error. Deliberately tiny: a list of toasts in a module
 * store, read through useSyncExternalStore. A toast library would be a
 * dependency we cannot justify for one component.
 */

export interface Toast {
  id: number;
  code: string;
  message: string;
  requestId: string | null;
}

let toasts: Toast[] = [];
let nextId = 1;
const subscribers = new Set<() => void>();

const emit = (): void => {
  for (const notify of subscribers) notify();
};

export const pushError = (error: unknown): void => {
  // 401 already navigates to /login, and 403 is handled in-page as an
  // explanatory empty state. Toasting either just adds noise to a known path.
  if (isApiError(error) && (error.status === 401 || error.status === 403)) return;

  const toast: Toast = isApiError(error)
    ? { id: nextId++, code: error.code, message: error.message, requestId: error.requestId }
    : {
        id: nextId++,
        code: 'CLIENT_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
        requestId: null,
      };

  toasts = [...toasts, toast].slice(-4);
  emit();
};

const dismiss = (id: number): void => {
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
};

const subscribe = (listener: () => void): (() => void) => {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
};

export const ErrorToaster = (): JSX.Element | null => {
  const items = useSyncExternalStore(
    subscribe,
    () => toasts,
    () => toasts,
  );

  useEffect(() => {
    if (items.length === 0) return;
    const timer = window.setTimeout(() => {
      const oldest = items[0];
      if (oldest) dismiss(oldest.id);
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [items]);

  if (items.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {items.map((toast) => (
        <div
          key={toast.id}
          role="alert"
          className="pointer-events-auto rounded border border-danger/40 bg-surface p-3 shadow-lg"
        >
          <div className="flex items-start justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-danger">{toast.code}</span>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="text-xs text-muted hover:text-ink"
              aria-label="Dismiss"
            >
              [x]
            </button>
          </div>
          <p className="mt-1 text-sm text-ink">{toast.message}</p>
          {toast.requestId ? (
            <p className="mt-1 select-all font-mono text-[11px] text-muted">
              requestId: {toast.requestId}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
};
