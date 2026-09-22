import type { MeResponse } from '@/types/api';

/**
 * Session storage policy.
 *
 * The access token lives in a module-level variable -- in memory only, never
 * in localStorage or sessionStorage. Anything written to web storage is
 * readable by any script that reaches this origin, so a single XSS (a bad
 * dependency, an injected analytics tag) becomes bearer-token exfiltration
 * against a banking API. Keeping it in a closure does not stop XSS, but it
 * removes the trivial, persistent, offline-readable copy.
 *
 * The cost is that a reload loses the session. That is the correct trade for
 * Phase 3, where the only credential is a 15-minute access token. Phase 4 adds
 * a refresh token in an HttpOnly + Secure + SameSite cookie, which JavaScript
 * cannot read; reload-survival becomes real then, by silently exchanging the
 * cookie for a new access token on boot rather than by persisting this one.
 *
 * The only thing persisted here is a non-sensitive boolean hint, so the login
 * screen can say "your session ended" instead of pretending nothing happened.
 */

const HINT_KEY = 'ledgercore.hadSession';

let accessToken: string | null = null;
let currentUser: MeResponse | null = null;

/** Notified when the API client sees a 401, so React can react to it. */
type UnauthorizedListener = () => void;
let unauthorizedListener: UnauthorizedListener | null = null;

export const session = {
  getToken: (): string | null => accessToken,
  getUser: (): MeResponse | null => currentUser,

  start(token: string): void {
    accessToken = token;
    safeSetHint(true);
  },

  setUser(user: MeResponse | null): void {
    currentUser = user;
  },

  clear(): void {
    accessToken = null;
    currentUser = null;
  },

  /** True if this browser tab previously held a session that a reload dropped. */
  hadSession: (): boolean => safeGetHint(),

  forgetHint(): void {
    safeSetHint(false);
  },

  onUnauthorized(listener: UnauthorizedListener): () => void {
    unauthorizedListener = listener;
    return () => {
      if (unauthorizedListener === listener) unauthorizedListener = null;
    };
  },

  notifyUnauthorized(): void {
    session.clear();
    if (unauthorizedListener) {
      unauthorizedListener();
    } else {
      // No React tree listening yet (e.g. a request fired during boot).
      window.location.replace('/login');
    }
  },
};

// Storage access throws in a locked-down browser profile; a hint is never
// worth failing a request over.
function safeSetHint(value: boolean): void {
  try {
    if (value) window.sessionStorage.setItem(HINT_KEY, '1');
    else window.sessionStorage.removeItem(HINT_KEY);
  } catch {
    /* ignore */
  }
}

function safeGetHint(): boolean {
  try {
    return window.sessionStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}
