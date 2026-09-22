import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Ledger seed: chart of accounts, products, customers, accounts, opening
 * balances and the authorisation slabs.
 *
 * All data is synthetic.
 *
 * Opening balances are posted as a real SYSTEM voucher against a Capital GL
 * head, not written straight into account_balance. Two reasons: the ledger
 * stays balanced from the very first row, and the balanced-voucher trigger
 * gets exercised on the seed itself -- if the seed can bypass the invariant,
 * so can anything else.
 */

const prisma = new PrismaClient();

const D = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

const GL_ACCOUNTS: Array<[code: string, name: string, side: 'ASSET' | 'LIABILITY', postable: boolean]> = [
  ['1000', 'Cash in hand', 'ASSET', true],
  ['1100', 'Advances to customers', 'ASSET', false],
  ['2000', 'Customer deposits', 'LIABILITY', false],
  ['2900', 'Suspense', 'LIABILITY', true],
  ['3000', 'Capital and reserves', 'LIABILITY', true],
  ['4000', 'Interest income', 'LIABILITY', true],
  ['5000', 'Charges and fees', 'LIABILITY', true],
];

const main = async (): Promise<void> => {
  const bank = await prisma.bank.findFirstOrThrow({ where: { code: 'SYNTH' } });
  const branches = await prisma.branch.findMany({ where: { bankId: bank.id }, orderBy: { code: 'asc' } });
  const hq = branches.find((branch) => branch.code === 101)!;
  const users = await prisma.user.findMany();
  const maker = users.find((user) => user.staffCode === 'M001')!;

  // ---- chart of accounts -------------------------------------------------
  for (const [code, name, side, isPostable] of GL_ACCOUNTS) {
    await prisma.glAccount.upsert({
      where: { code },
      update: { name, side, isPostable },
      create: { code, name, side, isPostable },
    });
  }
  const gl = new Map((await prisma.glAccount.findMany()).map((row) => [row.code, row]));

  // ---- authorisation slabs ----------------------------------------------
  //
  // Bank-wide defaults. The legacy Checker1..Checker4 columns, as data.
  //   under 10k   -> post immediately, no checker
  //   10k - 100k  -> one checker
  //   100k - 1m   -> two checkers
  //   1m and up   -> three checkers
  await prisma.authorizationPolicy.deleteMany({});
  await prisma.authorizationPolicy.createMany({
    data: [
      { minAmount: D('0'), maxAmount: D('10000'), requiredApprovals: 0 },
      { minAmount: D('10000'), maxAmount: D('100000'), requiredApprovals: 1 },
      { minAmount: D('100000'), maxAmount: D('1000000'), requiredApprovals: 2 },
      { minAmount: D('1000000'), maxAmount: null, requiredApprovals: 3 },
    ],
  });

  // ---- products ----------------------------------------------------------
  const productSpecs = [
    {
      code: 'SB01',
      name: 'Regular Savings',
      kind: 'SAVINGS' as const,
      balanceSide: 'LIABILITY' as const,
      minimumBalance: D('1000'),
      glCode: '2000',
    },
    {
      code: 'CA01',
      name: 'Current Account with OD',
      kind: 'CURRENT_OD' as const,
      balanceSide: 'LIABILITY' as const,
      minimumBalance: D('0'),
      glCode: '2000',
    },
    {
      code: 'TL01',
      name: 'Term Loan',
      kind: 'TERM_LOAN' as const,
      balanceSide: 'ASSET' as const,
      minimumBalance: D('0'),
      glCode: '1100',
      // A term loan account is repaid by transfer, not by a cash debit at the
      // counter. The legacy CashDrTrnYN flag, doing its job.
      allowCashDebit: false,
    },
    {
      code: 'GL01',
      name: 'Internal GL',
      kind: 'CURRENT_OD' as const,
      balanceSide: 'ASSET' as const,
      minimumBalance: D('0'),
      glCode: '1000',
    },
  ];

  for (const branch of branches) {
    for (const spec of productSpecs) {
      await prisma.product.upsert({
        where: { branchId_code: { branchId: branch.id, code: spec.code } },
        update: {},
        create: {
          branchId: branch.id,
          code: spec.code,
          name: spec.name,
          kind: spec.kind,
          balanceSide: spec.balanceSide,
          minimumBalance: spec.minimumBalance,
          glAccountId: gl.get(spec.glCode)!.id,
          allowCashDebit: spec.allowCashDebit ?? true,
        },
      });
    }
  }

  const products = await prisma.product.findMany({ where: { branchId: hq.id } });
  const product = (code: string) => products.find((row) => row.code === code)!;

  // ---- internal accounts (cash, capital, charges) -------------------------
  const internalSpecs: Array<[number: string, title: string, glCode: string]> = [
    ['GL101-CASH', 'Branch 101 Cash', '1000'],
    ['GL101-CAPITAL', 'Branch 101 Capital', '3000'],
    ['GL101-CHARGES', 'Branch 101 Charges Collected', '5000'],
  ];

  for (const [accountNumber, title, glCode] of internalSpecs) {
    await prisma.account.upsert({
      where: { accountNumber },
      update: {},
      create: {
        accountNumber,
        branchId: hq.id,
        productId: product('GL01').id,
        glAccountId: gl.get(glCode)!.id,
        title,
        openedOn: hq.openedOn,
        balance: { create: {} },
      },
    });
  }

  // ---- customers and their accounts --------------------------------------
  const customerSpecs = [
    { number: 100001, name: 'Anjali Bhosale', accountNumber: 'SB101000001', productCode: 'SB01', opening: '50000.00' },
    { number: 100002, name: 'Rohit Gaikwad', accountNumber: 'SB101000002', productCode: 'SB01', opening: '12500.00' },
    { number: 100003, name: 'Sunita Pawar', accountNumber: 'SB101000003', productCode: 'SB01', opening: '3200.00' },
    { number: 100004, name: 'Imran Kazi', accountNumber: 'CA101000001', productCode: 'CA01', opening: '75000.00', overdraft: '200000.00' },
    { number: 100005, name: 'Lata Chavan', accountNumber: 'CA101000002', productCode: 'CA01', opening: '0.00', overdraft: '50000.00' },
    // Frozen for a KYC lapse: credits still land, debits do not.
    { number: 100006, name: 'Prakash Jadhav', accountNumber: 'SB101000004', productCode: 'SB01', opening: '18000.00', freeze: 'DEBIT_BLOCKED' as const },
  ];

  for (const spec of customerSpecs) {
    const customer = await prisma.customer.upsert({
      where: { customerNumber: spec.number },
      update: {},
      create: {
        customerNumber: spec.number,
        fullName: spec.name,
        homeBranchId: hq.id,
        phone: `98${String(spec.number).slice(-8).padStart(8, '0')}`,
      },
    });

    await prisma.account.upsert({
      where: { accountNumber: spec.accountNumber },
      update: {},
      create: {
        accountNumber: spec.accountNumber,
        branchId: hq.id,
        productId: product(spec.productCode).id,
        customerId: customer.id,
        title: spec.name,
        openedOn: hq.openedOn,
        overdraftLimit: D(spec.overdraft ?? '0'),
        freezeType: spec.freeze ?? 'NONE',
        ...(spec.freeze ? { freezeReason: 'KYC documents pending' } : {}),
        balance: { create: {} },
      },
    });
  }

  // A term loan. ASSET side: the outstanding principal is a positive balance
  // because the customer owes the bank.
  const loanCustomer = await prisma.customer.findUniqueOrThrow({ where: { customerNumber: 100002 } });
  await prisma.account.upsert({
    where: { accountNumber: 'TL101000001' },
    update: {},
    create: {
      accountNumber: 'TL101000001',
      branchId: hq.id,
      productId: product('TL01').id,
      customerId: loanCustomer.id,
      title: 'Rohit Gaikwad -- Term Loan',
      openedOn: hq.openedOn,
      balance: { create: {} },
    },
  });

  // ---- opening balances, as a real balanced voucher ----------------------
  const accounts = await prisma.account.findMany({ where: { branchId: hq.id }, include: { balance: true } });
  const byNumber = new Map(accounts.map((row) => [row.accountNumber, row]));

  const alreadySeeded = await prisma.voucher.findFirst({ where: { narration: { startsWith: 'Opening balances' } } });

  if (!alreadySeeded) {
    const businessDate = await prisma.businessDate.findFirstOrThrow({
      where: { branchId: hq.id, status: 'OPEN' },
    });

    const batch = await prisma.batch.upsert({
      where: { businessDateId_code: { businessDateId: businessDate.id, code: 'SYSTEM' } },
      update: {},
      create: { branchId: hq.id, businessDateId: businessDate.id, code: 'SYSTEM' },
    });

    const openings = customerSpecs
      .filter((spec) => Number(spec.opening) > 0)
      .map((spec) => ({ accountNumber: spec.accountNumber, amount: spec.opening }));

    const total = openings.reduce((acc, row) => acc.plus(D(row.amount)), D('0'));

    // Customer deposits are a LIABILITY: crediting the customer increases what
    // the bank owes. The contra is Capital, also a liability, debited by the
    // same amount -- so the set balances and the books open clean.
    const capital = byNumber.get('GL101-CAPITAL')!;

    await prisma.$transaction(async (tx) => {
      const voucher = await tx.voucher.create({
        data: {
          voucherNumber: `V${hq.code}-${businessDate.workingDate.toISOString().slice(0, 10).replace(/-/g, '')}-00001`,
          branchId: hq.id,
          batchId: batch.id,
          transactionType: 'SYSTEM',
          status: 'POSTED',
          entryDate: businessDate.workingDate,
          postDate: businessDate.workingDate,
          valueDate: businessDate.workingDate,
          totalAmount: total,
          narration: 'Opening balances -- synthetic seed',
          makerId: maker.id,
          requiredApprovals: 0,
          postedAt: new Date(),
        },
      });

      let lineNumber = 0;
      for (const opening of openings) {
        lineNumber += 1;
        const account = byNumber.get(opening.accountNumber)!;
        await tx.voucherLine.create({
          data: {
            voucherId: voucher.id,
            postDate: businessDate.workingDate,
            lineNumber,
            accountId: account.id,
            drCr: 'CREDIT',
            amount: D(opening.amount),
            valueDate: businessDate.workingDate,
            balanceAfter: D(opening.amount),
          },
        });
        await tx.accountBalance.update({
          where: { accountId: account.id },
          data: {
            ledgerBalance: D(opening.amount),
            clearedBalance: D(opening.amount),
            lastPostedAt: new Date(),
            version: { increment: 1 },
          },
        });
      }

      lineNumber += 1;
      await tx.voucherLine.create({
        data: {
          voucherId: voucher.id,
          postDate: businessDate.workingDate,
          lineNumber,
          accountId: capital.id,
          drCr: 'DEBIT',
          amount: total,
          valueDate: businessDate.workingDate,
        },
      });
      await tx.accountBalance.update({
        where: { accountId: capital.id },
        // Capital is on an ASSET-side product here (GL01), so a debit
        // increases it. The sign convention is the product's, not the leg's.
        data: { ledgerBalance: total, clearedBalance: total, version: { increment: 1 } },
      });

      await tx.batch.update({
        where: { id: batch.id },
        data: { debitTotal: total, creditTotal: total, voucherCount: 1 },
      });
    });
  }

  const counts = {
    glAccounts: await prisma.glAccount.count(),
    products: await prisma.product.count(),
    customers: await prisma.customer.count(),
    accounts: await prisma.account.count(),
    policies: await prisma.authorizationPolicy.count(),
    vouchers: await prisma.voucher.count(),
    lines: await prisma.voucherLine.count(),
  };

  process.stdout.write(
    [
      'Ledger seed complete.',
      `  gl accounts : ${counts.glAccounts}`,
      `  products    : ${counts.products}`,
      `  customers   : ${counts.customers}`,
      `  accounts    : ${counts.accounts}`,
      `  auth slabs  : ${counts.policies}   (0 / 1 / 2 / 3 checkers by amount)`,
      `  vouchers    : ${counts.vouchers}`,
      `  lines       : ${counts.lines}`,
      '',
      '  SB101000004 is frozen DEBIT_BLOCKED on purpose.',
      '  TL01 forbids cash debits on purpose.',
      '  CA101000001 has a 200000.00 overdraft limit.',
      '',
    ].join('\n'),
  );
};

main()
  .catch((error: unknown) => {
    process.stderr.write(`Ledger seed failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
