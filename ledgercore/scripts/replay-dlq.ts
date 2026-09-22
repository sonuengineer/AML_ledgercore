/**
 * Operator tool: drain the dead-letter queue.
 *
 *   pnpm dlq:list
 *   pnpm dlq:replay -- --queue aml --limit 100 --dry-run
 *   pnpm dlq:replay -- --queue aml --limit 100 --operator S001
 *
 * WHY THIS FILE EXISTS
 *
 * `replayDeadLetter()` was written in Phase 7, has integration tests, and had
 * no caller outside those tests. The dead_letter table has `replayed_at` and
 * `replayed_by_id` columns, a `dead_letters_unreplayed` metric and a
 * `DeadLettersUnattended` alert -- an entire apparatus for a thing nobody
 * could actually do.
 *
 * Phase 16 found 2,116 dead letters sitting in it. The alert had been pending
 * the whole time.
 *
 * This is the second control in this codebase that was built, tested and never
 * connected to anything (the first was the circuit breaker). The lesson is not
 * "write more code" -- both were correct code. It is that a control with no
 * entry point is indistinguishable from a control that does not exist, and
 * neither a passing test suite nor a code review catches that.
 *
 * DESIGN NOTES
 *
 * - A CLI, not an HTTP endpoint. Replaying jobs re-runs work that touches
 *   money-adjacent state; it should require shell access to the environment,
 *   not a bearer token that an integration could hold.
 * - `--dry-run` is the default posture for anything that re-enqueues work in
 *   bulk. An operator reacting to an alert at 3am should be able to see what
 *   WOULD happen first.
 * - `--limit` is mandatory in spirit and defaulted low. Replaying 2,116 AML
 *   jobs at once is a self-inflicted version of the very incident that created
 *   them -- Phase 15 measured that burst taking Postgres to 594% CPU.
 * - Replay is safe to repeat: `replayed_at` is stamped, so a second operator
 *   reacting to the same alert re-enqueues nothing, and the consumers are
 *   idempotent anyway (aml_alert.dedupe_key).
 */

import { prisma } from '../src/shared/db/prisma';
import { replayDeadLetter } from '../src/workers/consumer';
import { bullQueue } from '../src/shared/queue/bullmq';

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const list = async (): Promise<void> => {
  const rows = await prisma.$queryRaw<
    Array<{ queue_name: string; unreplayed: bigint; replayed: bigint; last_error: string }>
  >`
    SELECT queue_name,
           count(*) FILTER (WHERE replayed_at IS NULL) AS unreplayed,
           count(*) FILTER (WHERE replayed_at IS NOT NULL) AS replayed,
           (array_agg(left(last_error, 80) ORDER BY created_at DESC))[1] AS last_error
      FROM dead_letter
     GROUP BY queue_name
     ORDER BY 2 DESC
  `;

  if (rows.length === 0) {
    console.log('dead-letter queue is empty');
    return;
  }

  console.log('queue        unreplayed  replayed  most recent error');
  for (const row of rows) {
    console.log(
      `${row.queue_name.padEnd(12)} ${String(row.unreplayed).padStart(10)} ${String(
        row.replayed,
      ).padStart(9)}  ${row.last_error}`,
    );
  }
};

const replay = async (): Promise<void> => {
  const queue = arg('queue');
  if (!queue) {
    console.error('--queue is required. Run `pnpm dlq:list` first.');
    process.exit(2);
  }

  const limit = Number(arg('limit') ?? 25);
  const dryRun = flag('dry-run');
  const operatorCode = arg('operator') ?? 'S001';

  const operator = await prisma.user.findUnique({
    where: { staffCode: operatorCode },
    select: { id: true, staffCode: true },
  });
  if (!operator) {
    console.error(`operator ${operatorCode} not found`);
    process.exit(2);
  }

  const letters = await prisma.deadLetter.findMany({
    where: { queueName: queue, replayedAt: null },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true, jobName: true, attempts: true, lastError: true },
  });

  const remaining = await prisma.deadLetter.count({
    where: { queueName: queue, replayedAt: null },
  });

  console.log(
    `${dryRun ? 'DRY RUN: would replay' : 'replaying'} ${letters.length} of ${remaining} ` +
      `unreplayed in "${queue}" as ${operator.staffCode}`,
  );

  if (dryRun) {
    for (const letter of letters.slice(0, 5)) {
      console.log(`  ${letter.id}  ${letter.jobName}  attempts=${letter.attempts}  ${letter.lastError.slice(0, 60)}`);
    }
    if (letters.length > 5) console.log(`  ... and ${letters.length - 5} more`);
    return;
  }

  let replayed = 0;
  const skipped: Record<string, number> = {};

  for (const letter of letters) {
    const result = await replayDeadLetter(letter.id, operator.id);
    if (result.replayed) replayed += 1;
    else skipped[result.reason ?? 'unknown'] = (skipped[result.reason ?? 'unknown'] ?? 0) + 1;
  }

  console.log(`replayed=${replayed} skipped=${JSON.stringify(skipped)} remaining=${remaining - replayed}`);
};

const main = async (): Promise<void> => {
  try {
    if (flag('replay')) await replay();
    else await list();
  } finally {
    await bullQueue.close().catch(() => undefined);
    await prisma.$disconnect();
  }
};

void main();
