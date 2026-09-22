import { PrismaClient } from '@prisma/client';
import { scryptHasher } from '../src/modules/identity/password.service';

/**
 * Development seed.
 *
 * Roles mirror what Phase 0 found in the legacy `Setup/Fin_*.mnu` files, but
 * as data rather than files on a server's disk. `legacyGroup` keeps the
 * mapping so existing bank documentation still lines up.
 *
 * All data here is synthetic.
 */

const prisma = new PrismaClient();

const PERMISSIONS: Array<[code: string, description: string]> = [
  ['branch:read', 'View branches and their business date'],
  ['user:read', 'View users'],
  ['user:manage', 'Create and modify users'],
  ['customer:read', 'View customers'],
  ['customer:create', 'Create customers'],
  ['account:read', 'View accounts and balances'],
  ['voucher:read', 'View vouchers'],
  ['voucher:create', 'Create vouchers (maker)'],
  ['voucher:authorize', 'Authorise vouchers (checker)'],
  ['voucher:reverse', 'Reverse a posted voucher'],
  ['dayend:run', 'Run day begin and day end'],
  ['report:read', 'View and generate reports'],
];

const ROLES: Array<{
  code: string;
  name: string;
  legacyGroup: number;
  permissions: string[];
}> = [
  {
    code: 'TELLER',
    name: 'Teller / Clerk',
    legacyGroup: 8,
    // Maker only. Explicitly NOT voucher:authorize -- the four-eyes rule is
    // enforced by the permission model, not only by the maker != checker check.
    permissions: ['branch:read', 'customer:read', 'account:read', 'voucher:read', 'voucher:create'],
  },
  {
    code: 'OFFICER',
    name: 'Officer / Supervisor',
    legacyGroup: 3,
    permissions: [
      'branch:read',
      'user:read',
      'customer:read',
      'customer:create',
      'account:read',
      'voucher:read',
      'voucher:create',
      'voucher:authorize',
      'report:read',
    ],
  },
  {
    code: 'BRANCH_MANAGER',
    name: 'Branch Manager',
    legacyGroup: 4,
    permissions: [
      'branch:read',
      'user:read',
      'customer:read',
      'customer:create',
      'account:read',
      'voucher:read',
      'voucher:create',
      'voucher:authorize',
      'voucher:reverse',
      'dayend:run',
      'report:read',
    ],
  },
  {
    code: 'AUDITOR',
    name: 'Auditor (read only)',
    legacyGroup: 999,
    permissions: ['branch:read', 'user:read', 'customer:read', 'account:read', 'voucher:read', 'report:read'],
  },
  {
    code: 'SYS_ADMIN',
    name: 'System Administrator',
    legacyGroup: 99,
    permissions: ['branch:read', 'user:read', 'user:manage', 'report:read'],
  },
];

const USERS: Array<{
  staffCode: string;
  displayName: string;
  roleCode: string;
  branchCode: number;
  multiBranchAccess?: boolean;
}> = [
  { staffCode: 'T001', displayName: 'Asha Kulkarni', roleCode: 'TELLER', branchCode: 101 },
  { staffCode: 'T002', displayName: 'Ravi Deshmukh', roleCode: 'TELLER', branchCode: 101 },
  { staffCode: 'O001', displayName: 'Meera Nair', roleCode: 'OFFICER', branchCode: 101 },
  { staffCode: 'M001', displayName: 'Suresh Patil', roleCode: 'BRANCH_MANAGER', branchCode: 101 },
  { staffCode: 'T101', displayName: 'Farah Shaikh', roleCode: 'TELLER', branchCode: 102 },
  { staffCode: 'O101', displayName: 'Vikram Rao', roleCode: 'OFFICER', branchCode: 102 },
  { staffCode: 'A001', displayName: 'Nikhil Joshi', roleCode: 'AUDITOR', branchCode: 101, multiBranchAccess: true },
  { staffCode: 'S001', displayName: 'Priya Menon', roleCode: 'SYS_ADMIN', branchCode: 101, multiBranchAccess: true },
];

/** Development only. Phase 4 adds a real password policy and forced rotation. */
const DEV_PASSWORD = 'ChangeMe#2026';

const main = async (): Promise<void> => {
  const passwordHash = await scryptHasher.hash(DEV_PASSWORD);

  const bank = await prisma.bank.upsert({
    where: { code: 'SYNTH' },
    update: {},
    create: { code: 'SYNTH', name: 'Synthetic Co-operative Bank Ltd', baseCurrency: 'INR' },
  });

  const branches = await Promise.all(
    [
      { code: 101, name: 'Head Office', openedOn: new Date('2015-04-01') },
      { code: 102, name: 'Shivaji Nagar', openedOn: new Date('2017-06-15') },
      { code: 103, name: 'Kothrud', openedOn: new Date('2019-01-10') },
    ].map((branch) =>
      prisma.branch.upsert({
        where: { bankId_code: { bankId: bank.id, code: branch.code } },
        update: {},
        create: { ...branch, bankId: bank.id },
      }),
    ),
  );

  const branchByCode = new Map(branches.map((branch) => [branch.code, branch]));

  for (const [code, description] of PERMISSIONS) {
    await prisma.permission.upsert({ where: { code }, update: { description }, create: { code, description } });
  }

  const permissionByCode = new Map(
    (await prisma.permission.findMany()).map((permission) => [permission.code, permission]),
  );

  for (const role of ROLES) {
    const created = await prisma.role.upsert({
      where: { code: role.code },
      update: { name: role.name, legacyGroup: role.legacyGroup },
      create: { code: role.code, name: role.name, legacyGroup: role.legacyGroup },
    });

    // Replace rather than merge, so removing a permission from this file
    // actually removes the grant. Silent drift between seed and database is
    // how the legacy .mnu files ended up differing per server.
    await prisma.rolePermission.deleteMany({ where: { roleId: created.id } });
    await prisma.rolePermission.createMany({
      data: role.permissions.map((permissionCode) => ({
        roleId: created.id,
        permissionId: permissionByCode.get(permissionCode)!.id,
      })),
    });
  }

  const roleByCode = new Map((await prisma.role.findMany()).map((role) => [role.code, role]));

  for (const user of USERS) {
    const branch = branchByCode.get(user.branchCode)!;
    const role = roleByCode.get(user.roleCode)!;

    await prisma.user.upsert({
      where: { staffCode: user.staffCode },
      update: { displayName: user.displayName, roleId: role.id, homeBranchId: branch.id },
      create: {
        staffCode: user.staffCode,
        displayName: user.displayName,
        email: `${user.staffCode.toLowerCase()}@synthbank.example`,
        homeBranchId: branch.id,
        roleId: role.id,
        multiBranchAccess: user.multiBranchAccess ?? false,
        passwordHash,
        passwordAlgo: 'scrypt',
      },
    });
  }

  // Open today for branch 101 and 102 so the business-date endpoint has
  // something to return. 103 is deliberately left with no open day, so the
  // DAY_NOT_OPEN business rule can be exercised.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const manager = await prisma.user.findUnique({ where: { staffCode: 'M001' } });

  for (const code of [101, 102]) {
    const branch = branchByCode.get(code)!;
    await prisma.businessDate.upsert({
      where: { branchId_workingDate: { branchId: branch.id, workingDate: today } },
      update: { status: 'OPEN' },
      create: {
        branchId: branch.id,
        workingDate: today,
        status: 'OPEN',
        openedAt: new Date(),
        openedById: manager?.id ?? null,
      },
    });
  }

  process.stdout.write(
    [
      'Seed complete.',
      `  bank      : ${bank.code} (${bank.name})`,
      `  branches  : ${branches.map((b) => b.code).join(', ')}  (103 has NO open business date, on purpose)`,
      `  roles     : ${ROLES.map((r) => r.code).join(', ')}`,
      `  users     : ${USERS.map((u) => u.staffCode).join(', ')}`,
      `  password  : ${DEV_PASSWORD}   (development only)`,
      '',
    ].join('\n'),
  );
};

main()
  .catch((error: unknown) => {
    process.stderr.write(`Seed failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
