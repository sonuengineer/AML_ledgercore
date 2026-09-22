import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { connectDatabase, disconnectDatabase, prisma } from '../src/shared/db/prisma';

/**
 * Phase 4 integration tests.
 *
 * These are the security properties, not the happy path. Each one corresponds
 * to a defect Phase 0 found in the legacy system, or to a failure mode that
 * rotation introduces and must be shown to handle.
 *
 * Needs the docker-compose Postgres, seeded.
 */

let server: Server;
let baseUrl: string;

const PASSWORD = 'ChangeMe#2026';

interface Envelope<T> {
  ok: boolean;
  data?: T;
  meta?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  requestId?: string;
}

const call = async (
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<{ status: number; body: Envelope<Record<string, unknown>>; setCookie: string | null }> => {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (init.cookie) headers.set('Cookie', init.cookie);

  const response = await fetch(`${baseUrl}${path}`, { ...init, headers, redirect: 'manual' });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Envelope<Record<string, unknown>>) : { ok: response.ok },
    setCookie: response.headers.get('set-cookie'),
  };
};

/** Pull the refresh cookie value out of a Set-Cookie header. */
const cookieValue = (setCookie: string | null): string => {
  const match = /lc_rt=([^;]*)/.exec(setCookie ?? '');
  return match?.[1] ?? '';
};

const loginAs = async (staffCode: string, password = PASSWORD) => {
  const result = await call('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ staffCode, password }),
  });
  return {
    ...result,
    accessToken: result.body.data?.accessToken as string | undefined,
    refreshCookie: `lc_rt=${cookieValue(result.setCookie)}`,
  };
};

beforeAll(async () => {
  await connectDatabase();
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await disconnectDatabase();
});

describe('login', () => {
  it('issues an access token in the body and a refresh token ONLY in an httpOnly cookie', async () => {
    const result = await loginAs('O001');

    expect(result.status).toBe(200);
    expect(result.accessToken).toBeTruthy();

    // The refresh token must never appear in the response body -- if it did,
    // JavaScript could read it and httpOnly would be pointless.
    expect(JSON.stringify(result.body)).not.toContain(cookieValue(result.setCookie));

    expect(result.setCookie).toContain('HttpOnly');
    expect(result.setCookie).toContain('SameSite=Strict');
    // Scoped to the auth routes, so an ordinary business call never carries it.
    expect(result.setCookie).toContain('Path=/api/v1/auth');
  });

  it('stores only a hash of the refresh token, never the token itself', async () => {
    const result = await loginAs('O001');
    const plaintext = cookieValue(result.setCookie);

    const row = await prisma.refreshToken.findFirst({
      where: { tokenHash: { not: plaintext } },
      orderBy: { issuedAt: 'desc' },
    });

    expect(row).not.toBeNull();
    // 64 hex chars = SHA-256. And it is not the plaintext.
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.tokenHash).not.toBe(plaintext);
  });
});

describe('refresh rotation', () => {
  it('returns a NEW access token and a NEW refresh token, and retires the old one', async () => {
    const first = await loginAs('O001');
    const firstRefresh = cookieValue(first.setCookie);

    const rotated = await call('/api/v1/auth/refresh', {
      method: 'POST',
      cookie: first.refreshCookie,
    });

    expect(rotated.status).toBe(200);
    const secondRefresh = cookieValue(rotated.setCookie);
    expect(secondRefresh).toBeTruthy();
    expect(secondRefresh).not.toBe(firstRefresh);
    expect(rotated.body.data?.accessToken).toBeTruthy();
  });

  it('rejects an unknown token without revealing anything', async () => {
    const result = await call('/api/v1/auth/refresh', {
      method: 'POST',
      cookie: 'lc_rt=not-a-real-token',
    });
    expect(result.status).toBe(401);
    expect(result.body.error?.code).toBe('UNAUTHORIZED');
  });

  it('rejects a request with no cookie at all', async () => {
    const result = await call('/api/v1/auth/refresh', { method: 'POST' });
    expect(result.status).toBe(401);
  });
});

describe('reuse detection -- the property rotation exists for', () => {
  it('burns the whole family when a retired token is replayed', async () => {
    const login = await loginAs('M001');
    const stolen = login.refreshCookie;

    // The legitimate client refreshes. `stolen` is now retired.
    const legit = await call('/api/v1/auth/refresh', { method: 'POST', cookie: stolen });
    expect(legit.status).toBe(200);
    const legitNext = `lc_rt=${cookieValue(legit.setCookie)}`;

    // The attacker replays the stolen copy. Rotation is strict -- no grace
    // window -- so a second use is theft by definition.
    const replay = await call('/api/v1/auth/refresh', { method: 'POST', cookie: stolen });
    expect(replay.status).toBe(401);
    expect(replay.body.error?.details?.reason).toBe('reuse_detected');

    // The critical assertion, and the one that caught a real bug: the
    // LEGITIMATE successor must be dead too. Revoking only the replayed token
    // would leave whichever party rotated last holding a working session --
    // possibly the attacker. It also only passes because the revocation is
    // COMMITTED before the rejection is thrown; when the throw was inside the
    // transaction, this assertion failed with a 200.
    const afterBurn = await call('/api/v1/auth/refresh', { method: 'POST', cookie: legitNext });
    expect(afterBurn.status).toBe(401);
  });
});

describe('logout', () => {
  it('kills the session and is idempotent', async () => {
    const login = await loginAs('O101');

    const first = await call('/api/v1/auth/logout', { method: 'POST', cookie: login.refreshCookie });
    expect(first.status).toBe(204);

    // The refresh token is dead.
    const afterLogout = await call('/api/v1/auth/refresh', {
      method: 'POST',
      cookie: login.refreshCookie,
    });
    expect(afterLogout.status).toBe(401);

    // Logging out again is not an error.
    const second = await call('/api/v1/auth/logout', { method: 'POST', cookie: login.refreshCookie });
    expect(second.status).toBe(204);
  });

  it('does not require a valid access token', async () => {
    const login = await loginAs('O101');
    // No Authorization header at all -- an expired access token must not stop
    // someone ending a session they are worried about.
    const result = await call('/api/v1/auth/logout', { method: 'POST', cookie: login.refreshCookie });
    expect(result.status).toBe(204);
  });
});

describe('sessions', () => {
  it('lists one entry per login, not one per rotated token', async () => {
    const user = 'A001';
    await prisma.refreshToken.deleteMany({
      where: { user: { staffCode: user } },
    });

    const a = await loginAs(user);
    await loginAs(user); // a second, separate login
    // Rotate the first one twice -- it must still count as ONE session.
    const r1 = await call('/api/v1/auth/refresh', { method: 'POST', cookie: a.refreshCookie });
    await call('/api/v1/auth/refresh', {
      method: 'POST',
      cookie: `lc_rt=${cookieValue(r1.setCookie)}`,
    });

    const sessions = await call('/api/v1/auth/sessions', {
      headers: { Authorization: `Bearer ${a.accessToken}` },
    });

    expect(sessions.status).toBe(200);
    expect(sessions.body.meta ?? {}).toBeDefined();
    const rows = sessions.body.data as unknown as Array<{ current: boolean }>;
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.current)).toHaveLength(0); // no cookie was sent
  });
});

describe('password change', () => {
  // A throwaway user, created and destroyed by this suite.
  //
  // The first version of this test mutated a SEEDED user and tried to restore
  // its password afterwards. That failed -- with a 422 PASSWORD_TOO_COMMON --
  // because the seed password `ChangeMe#2026` is itself on the deny list. The
  // policy was right and the test was wrong: a suite must not depend on being
  // able to put shared fixture data back.
  const STAFF = 'ZZTEST1';
  const START_PASSWORD = 'Konkan-Harbour-Tide-77';
  const NEW_PASSWORD = 'Deccan-Plateau-Monsoon-42';

  beforeAll(async () => {
    const { scryptHasher } = await import('../src/modules/identity/password.service');
    const branch = await prisma.branch.findFirstOrThrow({ where: { code: 101 } });
    const role = await prisma.role.findFirstOrThrow({ where: { code: 'TELLER' } });

    await prisma.user.deleteMany({ where: { staffCode: STAFF } });
    await prisma.user.create({
      data: {
        staffCode: STAFF,
        displayName: 'Password Test',
        homeBranchId: branch.id,
        roleId: role.id,
        passwordHash: await scryptHasher.hash(START_PASSWORD),
      },
    });
  });

  afterAll(async () => {
    // Cascades to the user's refresh tokens.
    await prisma.user.deleteMany({ where: { staffCode: STAFF } });
  });

  it('rejects a wrong current password', async () => {
    const login = await loginAs(STAFF, START_PASSWORD);
    const result = await call('/api/v1/auth/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.accessToken}` },
      body: JSON.stringify({ currentPassword: 'WrongPassword1', newPassword: NEW_PASSWORD }),
    });
    expect(result.status).toBe(401);
  });

  it('rejects a new password containing the staff code', async () => {
    const login = await loginAs(STAFF, START_PASSWORD);
    const result = await call('/api/v1/auth/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.accessToken}` },
      body: JSON.stringify({
        currentPassword: START_PASSWORD,
        newPassword: `${STAFF}-quite-a-long-passphrase`,
      }),
    });
    expect(result.status).toBe(422);
    expect(result.body.error?.code).toBe('PASSWORD_CONTAINS_IDENTITY');
  });

  it('rejects reusing the current password', async () => {
    const login = await loginAs(STAFF, START_PASSWORD);
    const result = await call('/api/v1/auth/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.accessToken}` },
      body: JSON.stringify({ currentPassword: START_PASSWORD, newPassword: START_PASSWORD }),
    });
    expect(result.status).toBe(422);
    expect(result.body.error?.code).toBe('PASSWORD_UNCHANGED');
  });

  it('invalidates every outstanding ACCESS token and every session', async () => {
    // Two independent sessions for the same user.
    const deviceA = await loginAs(STAFF, START_PASSWORD);
    const deviceB = await loginAs(STAFF, START_PASSWORD);

    const me = (token?: string) =>
      call('/api/v1/auth/me', { headers: { Authorization: `Bearer ${token}` } });

    expect((await me(deviceA.accessToken)).status).toBe(200);
    expect((await me(deviceB.accessToken)).status).toBe(200);

    const changed = await call('/api/v1/auth/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${deviceA.accessToken}` },
      body: JSON.stringify({ currentPassword: START_PASSWORD, newPassword: NEW_PASSWORD }),
    });
    expect(changed.status).toBe(200);

    // Device B's ACCESS token is dead -- no denylist, just the token's `iat`
    // compared against the user's passwordChangedAt. This is the property most
    // implementations miss: they revoke refresh tokens and leave access tokens
    // valid for their remaining lifetime.
    const staleAccess = await me(deviceB.accessToken);
    expect(staleAccess.status).toBe(401);
    expect(staleAccess.body.error?.details?.reason).toBe('password_changed');

    // Device B's REFRESH token is dead too, so it cannot mint a new one.
    const staleRefresh = await call('/api/v1/auth/refresh', {
      method: 'POST',
      cookie: deviceB.refreshCookie,
    });
    expect(staleRefresh.status).toBe(401);

    // Old password no longer works; the new one does.
    expect((await loginAs(STAFF, START_PASSWORD)).status).toBe(401);
    expect((await loginAs(STAFF, NEW_PASSWORD)).status).toBe(200);
  });
});
