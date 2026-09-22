import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { beginDraining } from '../src/modules/health/health.routes';
import { connectDatabase, disconnectDatabase } from '../src/shared/db/prisma';

/**
 * Integration test for the request lifecycle and the drain behaviour that
 * graceful shutdown depends on. Needs the docker-compose Postgres.
 *
 * Why this test exists: Windows does not deliver POSIX signals, so a
 * `kill -TERM` from the shell force-terminates the process instead of running
 * the SIGTERM handler. The SIGNAL DELIVERY is therefore verified under Linux
 * in Phase 12 (docker stop). What is verified HERE is the part that actually
 * carries the risk -- that readiness flips to 503 before the server stops
 * listening, so the load balancer drains the node instead of sending requests
 * into a closing socket.
 */

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await connectDatabase();
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await disconnectDatabase();
});

describe('health endpoints', () => {
  it('liveness answers without touching the database', async () => {
    const response = await fetch(`${baseUrl}/liveness`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'alive' });
  });

  it('readiness reports ready while the database is reachable', async () => {
    const response = await fetch(`${baseUrl}/readiness`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ready' });
  });
});

describe('request tracing', () => {
  it('echoes an inbound X-Request-Id', async () => {
    const response = await fetch(`${baseUrl}/liveness`, {
      headers: { 'X-Request-Id': 'trace-under-test' },
    });
    expect(response.headers.get('x-request-id')).toBe('trace-under-test');
  });

  it('generates one when the client does not send it', async () => {
    const response = await fetch(`${baseUrl}/liveness`);
    expect(response.headers.get('x-request-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  // A newline cannot even be tested through fetch -- undici rejects it client
  // side. The characters that DO reach a server and still cause trouble in a
  // log pipeline are these, so they are what the allowlist has to stop.
  it.each([
    ['contains separators', 'evil; injected=1'],
    ['contains whitespace', 'trace id with spaces'],
    ['is absurdly long', 'x'.repeat(500)],
  ])('replaces an inbound request id that %s', async (_label, hostile) => {
    const response = await fetch(`${baseUrl}/liveness`, {
      headers: { 'X-Request-Id': hostile },
    });
    const echoed = response.headers.get('x-request-id');
    expect(echoed).not.toBe(hostile);
    expect(echoed).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('error envelope', () => {
  it('returns a 404 in the standard shape, with the request id', async () => {
    const response = await fetch(`${baseUrl}/api/v1/does-not-exist`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(body.requestId).toBeTruthy();
  });

  it('rejects an unauthenticated call to a protected route', async () => {
    const response = await fetch(`${baseUrl}/api/v1/branches`);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' },
    });
  });
});

describe('drain ordering (the part graceful shutdown depends on)', () => {
  it('flips readiness to 503 while liveness stays 200', async () => {
    // Before: both healthy.
    expect((await fetch(`${baseUrl}/readiness`)).status).toBe(200);

    // Step 1 of shutdown: stop being routable, keep serving in-flight work.
    beginDraining();

    const readiness = await fetch(`${baseUrl}/readiness`);
    expect(readiness.status).toBe(503);
    await expect(readiness.json()).resolves.toMatchObject({ status: 'draining' });

    // Liveness must NOT fail here. If it did, the orchestrator would SIGKILL
    // the process mid-drain, which is exactly what draining is meant to avoid.
    expect((await fetch(`${baseUrl}/liveness`)).status).toBe(200);

    // And the node still answers real requests while draining.
    expect((await fetch(`${baseUrl}/api/v1/branches`)).status).toBe(401);
  });
});
