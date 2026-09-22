import { PrismaClient, Prisma } from '@prisma/client';

/**
 * AML rule seed. Synthetic thresholds modelled on Indian reporting practice.
 */

const prisma = new PrismaClient();
const D = (v: string): Prisma.Decimal => new Prisma.Decimal(v);

const RULES = [
  {
    code: 'CTR-CASH-10L',
    name: 'Cash withdrawals over 10 lakh in 30 days',
    kind: 'CASH_THRESHOLD' as const,
    windowDays: 30,
    threshold: D('1000000'),
    minCount: null,
  },
  {
    code: 'STRUCT-50K-7D',
    name: 'Structuring: 5 or more debits totalling over 50k in 7 days',
    kind: 'STRUCTURING' as const,
    windowDays: 7,
    threshold: D('50000'),
    minCount: 5,
  },
  {
    code: 'VELOCITY-2L-1D',
    name: 'Over 2 lakh debited in a single day',
    kind: 'VELOCITY' as const,
    windowDays: 1,
    threshold: D('200000'),
    minCount: null,
  },
];

const main = async (): Promise<void> => {
  for (const rule of RULES) {
    await prisma.amlRule.upsert({
      where: { code: rule.code },
      update: { name: rule.name, threshold: rule.threshold, windowDays: rule.windowDays, minCount: rule.minCount },
      create: rule,
    });
  }
  process.stdout.write(
    ['AML seed complete.', ...RULES.map((r) => `  ${r.code.padEnd(16)} ${r.kind.padEnd(16)} threshold ${r.threshold.toFixed(0).padStart(9)} over ${r.windowDays}d`), ''].join('\n'),
  );
};

main()
  .catch((e: unknown) => { process.stderr.write(String(e) + '\n'); process.exit(1); })
  .finally(() => void prisma.$disconnect());
