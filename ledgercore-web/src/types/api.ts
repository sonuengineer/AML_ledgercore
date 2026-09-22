/**
 * Mirror of the server's response envelope and Phase 3 resource shapes.
 *
 * Kept hand-written rather than generated: the surface is small, and a wrong
 * hand-written type fails the build, which is the same signal a generator
 * would give. When the API grows past a few modules this should become a
 * generated client from the OpenAPI document instead.
 */

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  meta?: Record<string, unknown>;
  requestId: string | null;
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  requestId: string | null;
}

export type BranchStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
export type DayStatus = 'PENDING' | 'OPEN' | 'CLOSING' | 'CLOSED';
export type UserStatus = 'ACTIVE' | 'DISABLED' | 'LOCKED';

/** The identity fields every session-bearing response carries. */
export interface SessionUser {
  id: string;
  staffCode: string;
  displayName: string;
  roleCode: string;
  branchId: string;
  /** Numeric on the wire (101, 102, ...), not a string. */
  branchCode: number;
}

export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  tokenType: string;
  mustChangePassword: boolean;
  user: SessionUser;
}

export interface MeResponse extends SessionUser {
  multiBranchAccess: boolean;
  permissions: string[];
}

export interface Branch {
  id: string;
  code: number;
  name: string;
  status: BranchStatus;
  /** ISO timestamp. */
  openedOn: string;
}

export interface BusinessDate {
  branchId: string;
  /** ISO date only (YYYY-MM-DD) -- the business date has no time component. */
  workingDate: string;
  status: DayStatus;
  openedAt: string | null;
  closedAt: string | null;
}

export interface UserSummary {
  id: string;
  staffCode: string;
  displayName: string;
  email: string | null;
  status: UserStatus;
  roleCode: string;
  branchCode: number;
  branchName: string;
  lastLoginAt: string | null;
  createdAt: string;
}

/** `meta` shape returned by keyset-paginated list endpoints. */
export interface PageMeta {
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}
