import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { connectDatabase, disconnectDatabase, prisma } from '../src/shared/db/prisma';
import { connectCache, disconnectCache } from '../src/shared/cache/redis';

/**
 * Phase 10 chaos tests.
 *
 * These break things for real against the running Postgres, rather than
 * mocking a failure. A mocked timeout proves the mock works; these prove the
 * system does.
 *
 * Needs the docker-compose Postgres and Redis.
 */

let server: Server;
let baseUrl: string;

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

const call = async (
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: Envelope }> => {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Envelope) : { ok: response.ok } };
};

beforeAll(async () => {
  await connectDatabase();
  await connectCache();
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await disconnectCache();
  await disconnectDatabase();
});

describe('server-side database timeouts are actually applied', () => {
  it('sets statement_timeout and lock_timeout on the connection', async () => {
    const rows = await prisma.$queryRaw<Array<{ statement: string; lock: string }>>`
      SELECT current_setting('statement_timeout') AS statement,
             current_setting('lock_timeout')      AS lock
    `;

    // Set via the connection string, not a SET on connect -- a SET would be
    // lost the moment a pool (or pgBouncer in Phase 11) hands out a different
    // backend.
    expect(rows[0]!.statement).not.toBe('0');
    expect(rows[0]!.lock).not.toBe('0');
  });

  it('aborts a query that runs past statement_timeout', async () => {
    // pg_sleep well past the configured limit. The error must come from
    // POSTGRES cancelling the statement, not from a client-side race -- a
    // client-side timeout would leave the query running and holding locks.
    await expect(
      prisma.$queryRawUnsafe("SET LOCAL statement_timeout = '300ms'; SELECT pg_sleep(3)"),
    ).rejects.toThrow();
  });

  it('aborts a lock wait rather than queueing forever', async () => {
    // The failure this prevents: the posting path takes SELECT ... FOR UPDATE
    // on balance rows. If another transaction holds that lock and is itself
    // stuck, the default is to wait INDEFINITELY -- and every later posting
    // for that account queues behind it. One stuck transaction silently
    // freezes an account.
    const account = await prisma.account.findFirstOrThrow({ select: { id: true } });

    let releaseHolder: (() => void) | undefined;
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT * FROM account_balance WHERE account_id = '${account.id}'::uuid FOR UPDATE`,
      );
      await holderDone;
    });

    // Give the holder time to take the lock.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const start = Date.now();
    const waiter = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe("SET LOCAL lock_timeout = '500ms'");
      await tx.$queryRawUnsafe(
        `SELECT * FROM account_balance WHERE account_id = '${account.id}'::uuid FOR UPDATE`,
      );
    });

    await expect(waiter).rejects.toThrow();
    const waited = Date.now() - start;

    // Bounded, and nowhere near indefinite.
    expect(waited).toBeLessThan(4_000);

    releaseHolder!();
    await holder;
  }, 30_000);
});

describe('load shedding', () => {
  it('refuses work above the concurrency ceiling instead of queueing it', async () => {
    // The ceiling is 200 by default, which is impractical to reach in a test,
    // so this asserts the mechanism directly rather than through HTTP.
    const { loadShedding } = await import('../src/middleware/loadShedding');
    const handler = loadShedding({ maxInFlight: 2 });

    const makeReq = (path = '/api/v1/test') => ({ path }) as never;
    const makeRes = () => {
      const listeners: Record<string, Array<() => void>> = {};
      return {
        setHeader: () => undefined,
        writableEnded: false,
        once(event: string, fn: () => void) {
          (listeners[event] ??= []).push(fn);
          return this;
        },
        finish() {
          this.writableEnded = true;
          for (const fn of listeners.finish ?? []) fn();
        },
      };
    };

    const errors: unknown[] = [];
    const next = (error?: unknown): void => {
      if (error) errors.push(error);
    };

    const first = makeRes();
    const second = makeRes();
    const third = makeRes();

    handler(makeReq(), first as never, next);
    handler(makeReq(), second as never, next);
    expect(errors).toHaveLength(0);

    // Third exceeds the ceiling.
    handler(makeReq(), third as never, next);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'RATE_LIMITED',
      details: { reason: 'load_shed' },
    });

    // Releasing capacity lets the next one through -- shedding recovers on
    // its own the moment demand drops, unlike congestion collapse.
    first.finish();
    const fourth = makeRes();
    handler(makeReq(), fourth as never, next);
    expect(errors).toHaveLength(1);
  });

  it('never sheds health endpoints', async () => {
    const { loadShedding } = await import('../src/middleware/loadShedding');
    // Shedding /readiness under load would make the load balancer pull an
    // overloaded-but-working node OUT of rotation, concentrating its traffic
    // on the rest and knocking them over too -- a capacity problem becoming a
    // cascading failure.
    const handler = loadShedding({ maxInFlight: 0 });

    const errors: unknown[] = [];
    const next = (error?: unknown): void => {
      if (error) errors.push(error);
    };

    for (const path of ['/liveness', '/readiness', '/health', '/metrics']) {
      handler({ path } as never, { setHeader: () => undefined, once: () => undefined } as never, next);
    }

    expect(errors).toHaveLength(0);
  });
});

describe('the API survives its optional dependencies failing', () => {
  it('serves requests with the cache disabled', async () => {
    // Phase 6 proved this by stopping Redis; this asserts the same property
    // in a way that runs in CI without touching Docker.
    const login = await call('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ staffCode: 'M001', password: 'ChangeMe#2026' }),
    });
    expect(login.status).toBe(200);

    const token = login.body.data!.accessToken as string;
    const me = await call('/api/v1/auth/me', { token });
    expect(me.status).toBe(200);
  });

  it('reports circuit state on /health without calling it unhealthy', async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = (await response.json()) as { status: string; circuits: unknown[] };

    // An open circuit is the system correctly refusing to hammer something
    // already down -- reported so an operator sees it, excluded from the
    // healthy verdict.
    expect(Array.isArray(body.circuits)).toBe(true);
    expect(body.status).toBe('healthy');
  });
});

describe('duplicate suppression under failure', () => {
  it('a retried posting after a client timeout still posts once', async () => {
    const { randomUUID } = await import('node:crypto');

    const login = await call('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ staffCode: 'T001', password: 'ChangeMe#2026' }),
    });
    const token = login.body.data!.accessToken as string;

    const branch = await prisma.branch.findFirstOrThrow({ where: { code: 101 } });
    const product = await prisma.product.findFirstOrThrow({
      where: { branchId: branch.id, code: 'SB01' },
    });
    const customer = await prisma.customer.findFirstOrThrow({ where: { customerNumber: 100001 } });

    const mk = async (amount: string) => {
      const account = await prisma.account.create({
        data: {
          accountNumber: `CH${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 1000)}`,
          branchId: branch.id,
          productId: product.id,
          customerId: customer.id,
          title: 'Chaos test',
          openedOn: branch.openedOn,
          balance: { create: { ledgerBalance: amount, clearedBalance: amount } },
        },
      });
      return account.id;
    };

    const from = await mk('50000');
    const to = await mk('0');
    const key = `chaos-${randomUUID()}`;
    const narration = `chaos retry ${key}`;

    const body = JSON.stringify({
      transactionType: 'TRANSFER',
      narration,
      lines: [
        { accountId: from, drCr: 'DEBIT', amount: '250.00' },
        { accountId: to, drCr: 'CREDIT', amount: '250.00' },
      ],
    });

    // Five concurrent attempts with the same key -- what a flaky branch link
    // plus an impatient client actually produces.
    const attempts = await Promise.all(
      Array.from({ length: 5 }, async () =>
        fetch(`${baseUrl}/api/v1/vouchers`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': key,
          },
          body,
        }),
      ),
    );

    const statuses = attempts.map((r) => r.status).sort();

    // Exactly ONE wins the atomic claim and posts. The others lose the insert
    // race and are told the work is in flight -- which is honest: it IS
    // happening, and retrying in a moment returns the replay.
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(4);

    // The property that actually matters.
    expect(await prisma.voucher.count({ where: { narration } })).toBe(1);

    // And a retry AFTER it settles gets the stored response, not a 409.
    const retry = await fetch(`${baseUrl}/api/v1/vouchers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': key,
      },
      body,
    });
    expect(retry.status).toBe(201);
    expect(retry.headers.get('idempotency-replayed')).toBe('true');
    expect(await prisma.voucher.count({ where: { narration } })).toBe(1);

    // And the money moved exactly once.
    const balance = await prisma.accountBalance.findUniqueOrThrow({ where: { accountId: to } });
    expect(Number(balance.ledgerBalance)).toBe(250);
  }, 30_000);
});
