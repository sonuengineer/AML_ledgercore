import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { connectDatabase, disconnectDatabase, prisma } from '../src/shared/db/prisma';

/**
 * Phase 5 integration tests: the ledger invariants.
 *
 * Not a happy-path suite. Each test is one of the five properties the posting
 * engine exists to protect, or a failure mode that only appears under
 * concurrency.
 *
 * Needs the docker-compose Postgres, seeded with both seeds.
 */

let server: Server;
let baseUrl: string;

const PASSWORD = 'ChangeMe#2026';

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

const tokens: Record<string, string> = {};
const accounts: Record<string, string> = {};

const call = async (
  path: string,
  init: RequestInit & { token?: string; idem?: string } = {},
): Promise<{ status: number; body: Envelope }> => {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  if (init.idem) headers.set('Idempotency-Key', init.idem);

  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Envelope) : { ok: response.ok } };
};

const login = async (staffCode: string): Promise<string> => {
  const result = await call('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ staffCode, password: PASSWORD }),
  });
  return result.body.data?.accessToken as string;
};

interface LineSpec {
  account: string;
  drCr: 'DEBIT' | 'CREDIT';
  amount: string;
}

const makeVoucher = async (
  token: string,
  lines: LineSpec[],
  options: { type?: string; narration?: string; idem?: string } = {},
) =>
  call('/api/v1/vouchers', {
    method: 'POST',
    token,
    idem: options.idem ?? randomUUID(),
    body: JSON.stringify({
      transactionType: options.type ?? 'TRANSFER',
      narration: options.narration ?? 'integration test',
      lines: lines.map((line) => ({
        accountId: accounts[line.account],
        drCr: line.drCr,
        amount: line.amount,
      })),
    }),
  });

/**
 * Mint a fresh, funded account.
 *
 * Earlier versions of these tests shared the seeded accounts and drained them,
 * so a test that ran late failed with INSUFFICIENT_FUNDS for reasons that had
 * nothing to do with what it was checking. A test that needs money makes its
 * own.
 */
const fundedAccount = async (
  amount: string,
  productCode = 'SB01',
  overdraftLimit = '0',
): Promise<string> => {
  const branch = await prisma.branch.findFirstOrThrow({ where: { code: 101 } });
  const product = await prisma.product.findFirstOrThrow({
    where: { branchId: branch.id, code: productCode },
  });
  const customer = await prisma.customer.findFirstOrThrow({ where: { customerNumber: 100001 } });

  const accountNumber = `T${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 1000)}`;
  const account = await prisma.account.create({
    data: {
      accountNumber,
      branchId: branch.id,
      productId: product.id,
      customerId: customer.id,
      title: 'Test funded account',
      openedOn: branch.openedOn,
      overdraftLimit,
      balance: { create: { ledgerBalance: amount, clearedBalance: amount } },
    },
  });
  accounts[accountNumber] = account.id;
  return accountNumber;
};

const balanceOf = async (accountNumber: string): Promise<string> => {
  const row = await prisma.accountBalance.findUniqueOrThrow({
    where: { accountId: accounts[accountNumber]! },
  });
  return row.ledgerBalance.toFixed(4);
};

beforeAll(async () => {
  await connectDatabase();
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  for (const staff of ['T001', 'O001', 'M001']) tokens[staff] = await login(staff);

  const rows = await prisma.account.findMany({ select: { accountNumber: true, id: true } });
  for (const row of rows) accounts[row.accountNumber] = row.id;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await disconnectDatabase();
});

// ---------------------------------------------------------------------------

describe('invariant 1 -- every voucher balances', () => {
  it('rejects an unbalanced voucher with both totals in the message', async () => {
    const result = await makeVoucher(tokens.T001!, [
      { account: 'SB101000001', drCr: 'DEBIT', amount: '5000.00' },
      { account: 'SB101000002', drCr: 'CREDIT', amount: '4000.00' },
    ]);

    expect(result.status).toBe(422);
    expect(result.body.error?.code).toBe('VOUCHER_NOT_BALANCED');
    expect(result.body.error?.details).toMatchObject({ difference: '1000.0000' });
  });

  it('rejects a negative line amount -- direction belongs in drCr', async () => {
    const result = await makeVoucher(tokens.T001!, [
      { account: 'SB101000001', drCr: 'DEBIT', amount: '-500.00' },
      { account: 'SB101000002', drCr: 'CREDIT', amount: '-500.00' },
    ]);
    expect(result.status).toBe(422);
    expect(result.body.error?.code).toBe('LINE_AMOUNT_NOT_POSITIVE');
  });

  it('rejects an amount that is not an exact decimal', async () => {
    // 0.1 + 0.2 as a float literal. The legacy FLOAT columns accepted this.
    const result = await makeVoucher(tokens.T001!, [
      { account: 'SB101000001', drCr: 'DEBIT', amount: '0.30000000000000004' },
      { account: 'SB101000002', drCr: 'CREDIT', amount: '0.30000000000000004' },
    ]);
    expect(result.status).toBe(400);
  });

  it('the DATABASE refuses an unbalanced voucher even if the service is bypassed', async () => {
    // The service check produces a good message; this constraint is what is
    // still true when someone writes a data-fix script in five years.
    const branch = await prisma.branch.findFirstOrThrow({ where: { code: 101 } });
    const batch = await prisma.batch.findFirstOrThrow({ where: { branchId: branch.id } });
    const maker = await prisma.user.findFirstOrThrow({ where: { staffCode: 'M001' } });
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const { transaction } = await import('../src/shared/db/prisma');

    await expect(
      transaction(async (tx) => {
        const voucher = await tx.voucher.create({
          data: {
            voucherNumber: `BYPASS-${randomUUID().slice(0, 8)}`,
            branchId: branch.id,
            batchId: batch.id,
            transactionType: 'SYSTEM',
            entryDate: today,
            postDate: today,
            valueDate: today,
            totalAmount: '100',
            narration: 'bypassing the service layer',
            makerId: maker.id,
            requiredApprovals: 0,
          },
        });
        // Debit 100, credit 60. Deliberately unbalanced.
        await tx.voucherLine.createMany({
          data: [
            { voucherId: voucher.id, postDate: today, lineNumber: 1, accountId: accounts.SB101000001!, drCr: 'DEBIT', amount: '100', valueDate: today },
            { voucherId: voucher.id, postDate: today, lineNumber: 2, accountId: accounts.SB101000002!, drCr: 'CREDIT', amount: '60', valueDate: today },
          ],
        });
      }),
    ).rejects.toThrow(/does not balance/);
  });
});

describe('invariant 2 -- no debit breaches the available balance', () => {
  it('blocks a debit that would breach the minimum balance', async () => {
    // SB01 carries a 1000 minimum balance, so 3200 means 2200 is available.
    const account = await fundedAccount('3200.00');
    const before = await balanceOf(account);
    const result = await makeVoucher(tokens.T001!, [
      { account, drCr: 'DEBIT', amount: '2500.00' },
      { account: 'SB101000002', drCr: 'CREDIT', amount: '2500.00' },
    ]);

    expect(result.status).toBe(422);
    expect(result.body.error?.code).toBe('INSUFFICIENT_FUNDS');
    // The message names all six inputs, so a teller can explain it at the counter.
    expect(result.body.error?.details).toMatchObject({ minimumBalance: '1000.0000' });
    // And nothing moved.
    expect(await balanceOf(account)).toBe(before);
  });

  it('allows an overdraft account to go negative, up to its limit', async () => {
    // Opens at zero with a 50,000 overdraft limit.
    const od = await fundedAccount('0.00', 'CA01', '50000');
    const result = await makeVoucher(tokens.T001!, [
      { account: od, drCr: 'DEBIT', amount: '9000.00' },
      { account: 'SB101000002', drCr: 'CREDIT', amount: '9000.00' },
    ]);
    expect(result.status).toBe(201);
    expect(Number(await balanceOf(od))).toBeLessThan(0);
  });

  it('blocks a debit beyond the overdraft limit', async () => {
    const od = await fundedAccount('0.00', 'CA01', '50000');
    const result = await makeVoucher(tokens.T001!, [
      { account: od, drCr: 'DEBIT', amount: '50001.00' },
      { account: 'SB101000002', drCr: 'CREDIT', amount: '50001.00' },
    ]);
    expect(result.status).toBe(422);
    expect(result.body.error?.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('nets debits and credits on the same account before checking', async () => {
    // Debit 3000 and credit 2900 on an account with only ~700 available:
    // the NET is 100, so it must be allowed. Checking line by line would
    // wrongly reject it.
    const account = await fundedAccount('1800.00');
    const available = await prisma.$queryRaw<Array<{ available: string }>>`
      SELECT available_balance::text AS available
        FROM account_available_balance WHERE account_id = ${accounts[account]}::uuid
    `;
    expect(Number(available[0]!.available)).toBeLessThan(3000);

    const result = await makeVoucher(tokens.T001!, [
      { account, drCr: 'DEBIT', amount: '3000.00' },
      { account, drCr: 'CREDIT', amount: '2900.00' },
      { account: 'SB101000002', drCr: 'CREDIT', amount: '100.00' },
    ]);
    expect(result.status).toBe(201);
  });
});

describe('account and product rules', () => {
  it('blocks a debit on a frozen account but allows a credit', async () => {
    const debit = await makeVoucher(tokens.T001!, [
      { account: 'SB101000004', drCr: 'DEBIT', amount: '100.00' },
      { account: 'SB101000002', drCr: 'CREDIT', amount: '100.00' },
    ]);
    expect(debit.status).toBe(422);
    expect(debit.body.error?.code).toBe('ACCOUNT_DEBIT_FROZEN');

    // A salary must still land in an account frozen for a KYC lapse.
    const funded = await fundedAccount('5000.00');
    const credit = await makeVoucher(tokens.T001!, [
      { account: funded, drCr: 'DEBIT', amount: '100.00' },
      { account: 'SB101000004', drCr: 'CREDIT', amount: '100.00' },
    ]);
    expect(credit.status).toBe(201);
  });

  it('honours the product transaction-type flags', async () => {
    const result = await makeVoucher(
      tokens.T001!,
      [
        { account: 'TL101000001', drCr: 'DEBIT', amount: '100.00' },
        { account: 'GL101-CASH', drCr: 'CREDIT', amount: '100.00' },
      ],
      { type: 'CASH' },
    );
    expect(result.status).toBe(422);
    expect(result.body.error?.code).toBe('TRANSACTION_TYPE_NOT_ALLOWED');
  });
});

describe('invariant 3 -- four eyes', () => {
  it('posts immediately below the approval threshold', async () => {
    const funded = await fundedAccount('5000.00');
    const result = await makeVoucher(tokens.T001!, [
      { account: funded, drCr: 'DEBIT', amount: '500.00' },
      { account: 'SB101000002', drCr: 'CREDIT', amount: '500.00' },
    ]);
    expect(result.status).toBe(201);
    expect(result.body.data).toMatchObject({ requiredApprovals: 0, status: 'POSTED' });
  });

  it('requires a checker above it, and refuses the maker as that checker', async () => {
    const funded = await fundedAccount('50000.00');
    // The OFFICER makes it, so the four-eyes rule is what blocks them --
    // not a missing permission, which would be a weaker test.
    const created = await makeVoucher(tokens.O001!, [
      { account: funded, drCr: 'DEBIT', amount: '20000.00' },
      { account: 'SB101000002', drCr: 'CREDIT', amount: '20000.00' },
    ]);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ requiredApprovals: 1, status: 'PENDING_AUTH' });

    const voucherId = created.body.data!.voucherId as string;

    const selfApprove = await call(`/api/v1/vouchers/${voucherId}/approve`, {
      method: 'POST',
      token: tokens.O001!,
      body: JSON.stringify({}),
    });
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.error?.details).toMatchObject({ rule: 'four_eyes' });

    const approved = await call(`/api/v1/vouchers/${voucherId}/approve`, {
      method: 'POST',
      token: tokens.M001!,
      body: JSON.stringify({ remarks: 'checked' }),
    });
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({ posted: true, status: 'POSTED' });
  });

  it('the DATABASE also refuses a maker approving their own voucher', async () => {
    const funded = await fundedAccount('50000.00');
    const created = await makeVoucher(tokens.O001!, [
      { account: funded, drCr: 'DEBIT', amount: '20000.00' },
      { account: 'SB101000002', drCr: 'CREDIT', amount: '20000.00' },
    ]);
    const voucherId = created.body.data!.voucherId as string;
    const officer = await prisma.user.findFirstOrThrow({ where: { staffCode: 'O001' } });

    await expect(
      prisma.authorizationStep.create({
        data: { voucherId, level: 1, actorId: officer.id, decision: 'APPROVED' },
      }),
    ).rejects.toThrow(/Four-eyes violation/);
  });
});

describe('invariant 4 -- a retry posts once', () => {
  it('replays the stored response and creates exactly one voucher', async () => {
    const key = `test-${randomUUID()}`;
    const funded = await fundedAccount('5000.00');
    const lines: LineSpec[] = [
      { account: funded, drCr: 'DEBIT', amount: '321.00' },
      { account: 'SB101000002', drCr: 'CREDIT', amount: '321.00' },
    ];
    const narration = `idem-${key}`;

    const first = await makeVoucher(tokens.T001!, lines, { idem: key, narration });
    const second = await makeVoucher(tokens.T001!, lines, { idem: key, narration });
    const third = await makeVoucher(tokens.T001!, lines, { idem: key, narration });

    expect(first.status).toBe(201);
    expect(second.body.data?.voucherId).toBe(first.body.data?.voucherId);
    expect(third.body.data?.voucherId).toBe(first.body.data?.voucherId);

    expect(await prisma.voucher.count({ where: { narration } })).toBe(1);
  });

  it('refuses the same key with a different body', async () => {
    const key = `test-${randomUUID()}`;
    const funded = await fundedAccount('5000.00');
    await makeVoucher(
      tokens.T001!,
      [
        { account: funded, drCr: 'DEBIT', amount: '11.00' },
        { account: 'SB101000002', drCr: 'CREDIT', amount: '11.00' },
      ],
      { idem: key },
    );

    const different = await makeVoucher(
      tokens.T001!,
      [
        { account: funded, drCr: 'DEBIT', amount: '22.00' },
        { account: 'SB101000002', drCr: 'CREDIT', amount: '22.00' },
      ],
      { idem: key },
    );

    expect(different.status).toBe(409);
    expect(different.body.error?.code).toBe('CONFLICT');
  });

  it('requires the header on the money endpoint', async () => {
    const result = await call('/api/v1/vouchers', {
      method: 'POST',
      token: tokens.T001!,
      body: JSON.stringify({
        transactionType: 'TRANSFER',
        narration: 'no key',
        lines: [
          { accountId: accounts.SB101000001, drCr: 'DEBIT', amount: '1.00' },
          { accountId: accounts.SB101000002, drCr: 'CREDIT', amount: '1.00' },
        ],
      }),
    });
    expect(result.status).toBe(400);
  });
});

describe('invariant 5 -- events commit with the state change', () => {
  it('writes an outbox row in the same transaction as the posting', async () => {
    const funded = await fundedAccount('5000.00');
    const created = await makeVoucher(tokens.T001!, [
      { account: funded, drCr: 'DEBIT', amount: '250.00' },
      { account: 'SB101000002', drCr: 'CREDIT', amount: '250.00' },
    ]);
    const voucherId = created.body.data!.voucherId as string;

    const events = await prisma.outboxEvent.findMany({ where: { aggregateId: voucherId } });
    const types = events.map((event) => event.eventType).sort();

    expect(types).toContain('voucher.created');
    expect(types).toContain('voucher.posted');
    // Every event is PENDING until the relay (Phase 7) publishes it.
    expect(events.every((event) => event.status === 'PENDING')).toBe(true);
    // And it carries the request id, so the worker's logs join this trace.
    expect(events[0]?.requestId).toBeTruthy();
  });

  it('writes NO outbox row when the voucher is rejected', async () => {
    const before = await prisma.outboxEvent.count();
    await makeVoucher(tokens.T001!, [
      { account: 'SB101000001', drCr: 'DEBIT', amount: '5000.00' },
      { account: 'SB101000002', drCr: 'CREDIT', amount: '4999.00' },
    ]);
    // The transaction rolled back, so the event rolled back with it. This is
    // the whole point of the outbox -- no phantom events.
    expect(await prisma.outboxEvent.count()).toBe(before);
  });
});

describe('concurrency', () => {
  it('two simultaneous transfers between the same pair of accounts do not deadlock', async () => {
    // A -> B and B -> A at the same instant. Without a consistent lock order
    // this is the textbook deadlock: each transaction holds what the other
    // wants. Locking by account_id ascending means one simply waits.
    const left = await fundedAccount('5000.00');
    const right = await fundedAccount('5000.00');

    const results = await Promise.all([
      makeVoucher(tokens.T001!, [
        { account: left, drCr: 'DEBIT', amount: '100.00' },
        { account: right, drCr: 'CREDIT', amount: '100.00' },
      ]),
      makeVoucher(tokens.T001!, [
        { account: right, drCr: 'DEBIT', amount: '100.00' },
        { account: left, drCr: 'CREDIT', amount: '100.00' },
      ]),
    ]);

    for (const result of results) expect(result.status).toBe(201);
  });

  it('concurrent debits cannot together overdraw an account', async () => {
    // Fund a fresh account with exactly 5000 available, then fire five
    // simultaneous 2000 debits. At most two can succeed.
    const branch = await prisma.branch.findFirstOrThrow({ where: { code: 101 } });
    const product = await prisma.product.findFirstOrThrow({
      where: { branchId: branch.id, code: 'CA01' },
    });
    const customer = await prisma.customer.findFirstOrThrow({ where: { customerNumber: 100001 } });

    const accountNumber = `RACE${Date.now().toString().slice(-8)}`;
    const account = await prisma.account.create({
      data: {
        accountNumber,
        branchId: branch.id,
        productId: product.id,
        customerId: customer.id,
        title: 'Race test',
        openedOn: branch.openedOn,
        balance: { create: { ledgerBalance: '5000', clearedBalance: '5000' } },
      },
    });
    accounts[accountNumber] = account.id;

    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        makeVoucher(tokens.T001!, [
          { account: accountNumber, drCr: 'DEBIT', amount: '2000.00' },
          { account: 'SB101000002', drCr: 'CREDIT', amount: '2000.00' },
        ]),
      ),
    );

    const succeeded = attempts.filter((result) => result.status === 201).length;
    expect(succeeded).toBeLessThanOrEqual(2);

    const balance = await prisma.accountBalance.findUniqueOrThrow({
      where: { accountId: account.id },
    });
    // The floor, not below it.
    expect(Number(balance.ledgerBalance)).toBeGreaterThanOrEqual(0);
  });
});

describe('reversal', () => {
  it('creates a mirrored contra voucher and never edits the original', async () => {
    const funded = await fundedAccount('5000.00');
    const created = await makeVoucher(tokens.T001!, [
      { account: funded, drCr: 'DEBIT', amount: '750.00' },
      { account: 'SB101000002', drCr: 'CREDIT', amount: '750.00' },
    ]);
    const originalId = created.body.data!.voucherId as string;

    const reversed = await call(`/api/v1/vouchers/${originalId}/reverse`, {
      method: 'POST',
      token: tokens.M001!,
      idem: randomUUID(),
      body: JSON.stringify({ reason: 'wrong beneficiary' }),
    });
    expect(reversed.status).toBe(201);

    const original = await prisma.voucher.findUniqueOrThrow({ where: { id: originalId } });
    expect(original.status).toBe('REVERSED');
    // The original's own lines are untouched. A correction is a new voucher.
    const lines = await prisma.voucherLine.findMany({ where: { voucherId: originalId } });
    expect(lines.find((line) => line.lineNumber === 1)?.drCr).toBe('DEBIT');

    const reversalId = reversed.body.data!.voucherId as string;
    const reversalLines = await prisma.voucherLine.findMany({
      where: { voucherId: reversalId },
      orderBy: { lineNumber: 'asc' },
    });
    expect(reversalLines[0]?.drCr).toBe('CREDIT');
    expect(reversalLines[1]?.drCr).toBe('DEBIT');

    const again = await call(`/api/v1/vouchers/${originalId}/reverse`, {
      method: 'POST',
      token: tokens.M001!,
      idem: randomUUID(),
      body: JSON.stringify({ reason: 'again' }),
    });
    expect(again.status).toBe(422);
  });
});

describe('the ledger as a whole', () => {
  it('still balances to the paisa after every test above', async () => {
    const rows = await prisma.$queryRaw<Array<{ difference: string }>>`
      SELECT (COALESCE(SUM(amount) FILTER (WHERE dr_cr = 'DEBIT'), 0)
            - COALESCE(SUM(amount) FILTER (WHERE dr_cr = 'CREDIT'), 0))::text AS difference
        FROM voucher_line
    `;
    expect(Number(rows[0]!.difference)).toBe(0);
  });

  it('has no unbalanced voucher anywhere', async () => {
    const rows = await prisma.$queryRaw<Array<{ voucher_number: string }>>`
      SELECT v.voucher_number
        FROM voucher v JOIN voucher_line vl ON vl.voucher_id = v.id
       GROUP BY v.id, v.voucher_number
      HAVING SUM(vl.amount) FILTER (WHERE vl.dr_cr = 'DEBIT')
          <> SUM(vl.amount) FILTER (WHERE vl.dr_cr = 'CREDIT')
       LIMIT 5
    `;
    expect(rows).toHaveLength(0);
  });
});
