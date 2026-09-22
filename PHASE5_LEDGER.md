# Phase 5 -- Database Engineering and the Ledger

> Built and verified 2026-09-21/22. This is the phase the whole project exists
> for. Still Step-1 topology: no Redis, no queue. The outbox rows accumulate
> and wait for the Phase 7 relay.

---

## 1. What we built

13 new tables, one view, 5 partitions, 18 CHECK constraints, 3 triggers,
4 partial indexes, 2 GIN trigram indexes, and a posting engine that protects
five invariants.

```
  POST   /api/v1/vouchers                     create (Idempotency-Key REQUIRED)
  GET    /api/v1/vouchers                     branch list / authorisation queue
  GET    /api/v1/vouchers/:id                 one voucher with lines + approvals
  POST   /api/v1/vouchers/:id/approve         checker approves; posts on the last level
  POST   /api/v1/vouchers/:id/reject          checker rejects
  POST   /api/v1/vouchers/:id/reverse         contra voucher (Idempotency-Key REQUIRED)
  GET    /api/v1/accounts/:id/balance         six numbers, not one
  GET    /api/v1/accounts/:id/statement       keyset paged, partition pruned
```

### The five invariants

1. `sum(debits) = sum(credits)`, to the paisa
2. no debit takes an account below its available balance
3. the maker is never a checker, and a voucher posts only when every required
   approval level is filled
4. a retried request posts once
5. balances and the events announcing them commit together, or not at all

Each is enforced twice: in the service, where the error message is written for
a teller, and in the database, where it is still true in five years when
somebody runs a data-fix script.

---

## 2. ER diagram

```
                         bank
                          |
                        branch ----------< business_date ----< batch
                          |                                      |
      gl_account ----< product                                   |
           |              |                                      |
           |              |                                      |
      customer -------< account ---- account_balance (1:1, versioned)
           |              |
           |              +-------------------------+
           |                                        |
         user ----< voucher >---- batch             |
                      |   |                         |
                      |   +---< authorization_step  |
                      |                             |
                      +---< voucher_line >----------+
                              PARTITION BY RANGE (post_date)
                              2026q1 | q2 | q3 | q4 | 2027q1 | overflow

  authorization_policy   amount slab -> how many checkers
  idempotency_key        a retry replays, never re-posts
  outbox_event           events, written in the state-change transaction
  audit_event            append only

  VIEW account_available_balance
       = cleared - lien - hold - minimum + overdraft_limit
```

Thirteen tables against the legacy system's 1486. Every one carries an
invariant; none is there for completeness.

---

## 3. The decisions that matter

### 3.1 Balances live in their own table

`account` is read constantly and written almost never. `account_balance` is
written on every posting. Splitting them keeps the hot-updated row narrow,
which means less WAL per update and far less bloat for autovacuum to chase.
The legacy `D009022` carried all of it inline, in FLOAT.

### 3.2 Direction is a column, amounts are always positive

```sql
ALTER TABLE voucher_line
  ADD CONSTRAINT voucher_line_amount_positive CHECK (amount > 0);
```

Signed amounts *plus* a direction flag is how ledgers double-negate. The
constraint makes the convention unbreakable.

Which way a debit moves a balance then depends on the product's
`balance_side`: on a LIABILITY account (a customer deposit -- the bank owes
them) a debit REDUCES the balance; on an ASSET account (a loan, branch cash) a
debit INCREASES it. That derivation lives in one function, `signedDelta`.

### 3.3 The balanced-voucher constraint has to be deferred

It spans two tables, so it cannot be a CHECK. It is a `CONSTRAINT TRIGGER
... DEFERRABLE INITIALLY DEFERRED`, because a voucher is *legitimately*
unbalanced while its lines are being inserted one at a time.

That decision led straight to the biggest finding of the phase -- section 5.1.

### 3.4 Deadlock avoidance by lock ordering

```sql
SELECT ... FROM account_balance ab
 WHERE ab.account_id = ANY($1::uuid[])
 ORDER BY ab.account_id
   FOR UPDATE OF ab
```

Two simultaneous transfers, A->B and B->A, deadlock if each locks in the order
its own voucher happens to list: transaction 1 holds A and wants B, transaction
2 holds B and wants A. Postgres detects the cycle and kills one after
`deadlock_timeout`, so the user sees a slow, random failure.

Locking in a globally consistent order -- account id ascending, always -- means
there is no cycle to form. One transaction simply waits. A one-line `ORDER BY`
for a class of bug that is otherwise very hard to reproduce.

`FOR UPDATE OF ab` locks only the balance rows. Locking the joined `account`,
`product` or `customer` rows too would serialise unrelated work: every voucher
touching the same product would queue behind every other.

### 3.5 Available balance is six numbers

```
available = cleared - lien - hold - minimum + overdraft_limit
```

Defined once in `availableFrom()`, and mirrored by the
`account_available_balance` view so a report and the posting path cannot drift.
Getting this subtly different in one call site is the classic "the ATM let me
overdraw" bug.

Debits are also **netted per account before checking**: a voucher that debits
3000 and credits 2900 on the same account needs only 100 available. Checking
line by line would reject a legitimate voucher.

### 3.6 Voucher numbers: advisory lock, not a sequence

The number must reset daily and be gapless within the day -- auditors treat a
missing number as a missing voucher. A Postgres sequence gives neither: it
never resets, and `nextval` is explicitly non-transactional, so a rolled-back
voucher burns its number permanently.

`pg_advisory_xact_lock(branch_code, yyyymmdd)` scopes contention to one branch
for one day and releases at COMMIT with no cleanup path to forget.

### 3.7 Partitioning `voucher_line`

Range partitioned by `post_date`, quarterly. It buys partition pruning, cheap
archival (DETACH rather than a giant DELETE that would be a vacuum
catastrophe), and smaller per-partition indexes.

Two costs, both real: the partition key must be in the primary key (hence the
composite `(id, post_date)`), and a query that does not filter on `post_date`
must touch every partition. There is a DEFAULT partition so a mis-dated insert
fails loudly rather than vanishing; any row landing there is a bug, and Phase 9
alerts on it.

Prisma cannot express partitioning, so the generated migration's `CREATE TABLE`
is replaced by a hand-written block in the same migration file.

### 3.8 Corrections are reversals

A reversal is a new contra voucher referencing the original, with every leg
flipped; the original is marked REVERSED and never edited. The value date
carries over from the original, so interest already accrued unwinds over the
same period rather than from today. The reversal is itself subject to approval,
because it moves money exactly as much as the original did.

---

## 4. Query optimisation: slow query -> EXPLAIN -> fix

Measured on 200,006 vouchers / 400,016 lines / 100,006 customers, synthetic.
`max_parallel_workers_per_gather = 0` for comparable plans.

### 4.1 Partition pruning

**Query:** account statement.

```
WITHOUT a post_date predicate                    WITH post_date BETWEEN
------------------------------------             ------------------------------------
Merge Append across 6 partitions                 Index Scan, voucher_line_2026q3 only
  -> 6 index scans, one per partition            -> 1 index scan
Planning Time: 11.394 ms                         Planning Time:  0.446 ms
Execution Time: 3.350 ms                         Execution Time: 2.634 ms
```

**The honest reading:** the win here is in *planning*, 25x, plus not touching
six indexes. Execution barely moved because this account has few rows. At a
branch's real volume the execution gap widens with every partition added --
which is the point: pruning is what stops the query degrading as the ledger
grows.

### 4.2 Keyset vs OFFSET pagination

**Query:** page 2000 of the branch voucher list, 25 per page.

The first EXPLAIN exposed a genuinely missing index -- see 5.2. After adding
`voucher(branch_id, created_at DESC, id DESC)`:

```
OFFSET 50000                                     KEYSET (cursor as literals)
------------------------------------             ------------------------------------
Index Scan, actual rows=50025                    Index Scan, actual rows=25
  reads 50,025 rows to return 25                 Index Cond includes the ROW(...) compare
Buffers: 50,377                                  Buffers: 28
Execution Time: 40.221 ms                        Execution Time: 0.383 ms
```

**1,800x fewer buffers, 105x faster.** And at page 8000:

```
KEYSET, page 8000:  Buffers: 28   Execution Time: 0.337 ms
```

Identical. That is the property: keyset is O(page size) at any depth, OFFSET is
O(offset).

### 4.3 Partial index on the authorisation queue

```
voucher_branch_id_status_created_at_idx   1264 kB     (full)
voucher_pending_queue_idx                   16 kB     (WHERE status = 'PENDING_AUTH')
```

**79x smaller**, because pending rows are a fraction of a percent of the table.
The queue query runs in 3 buffers / 0.052 ms. A small index stays in cache; a
table-sized one does not.

### 4.4 Customer name search

**Query:** `full_name ILIKE '%gaikwad%'` over 100,006 customers. The legacy
system ran `LIKE` on a `CHAR(50)`, which is a sequential scan every time -- and
a btree cannot help a leading wildcard, because there is nothing to seek to.

```
NO trigram index                                 GIN pg_trgm
------------------------------------             ------------------------------------
Seq Scan on customer                             Bitmap Index Scan -> Bitmap Heap Scan
  rows matched:  8,341                           rows matched: 8,341
  rows discarded: 91,665                         index read:  28 buffers
Buffers: 1,566                                   Buffers: 858
```

For a selective term -- the realistic teller search -- it is 33 buffers and
0.899 ms.

---

## 5. Five real bugs, and what each one teaches

### 5.1 Prisma silently swallows a COMMIT failure

The most important finding in the phase.

The balanced-voucher trigger is DEFERRABLE, so it fires at COMMIT. A test
deliberately inserted an unbalanced voucher through Prisma's interactive
`$transaction` and asserted it would reject.

It resolved.

A probe confirmed it exactly:

```
>>> OUTCOME: COMMITTED (unexpected)
>>> probe rows left: 0
```

Prisma's own logger printed `transaction failed to commit`. The data rolled
back correctly. And `$transaction` **resolved the promise anyway**. The
application would have told a teller their voucher posted while nothing was
written.

**Fix**, in the shared `transaction()` helper:

```ts
const result = await fn(tx);
await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
return result;
```

Forcing deferred triggers to fire while the transaction is still open means the
error comes back through the normal path.

The general lesson: **a deferred constraint is only as good as the driver's
commit-error handling.** Worth checking on any stack, not just this one.

### 5.2 An EXPLAIN found a missing index I had not predicted

The voucher list query -- branch, newest first, no status filter -- did a
Seq Scan over 200k rows plus a **9.8 MB external merge sort to disk**. My
`(branch_id, status, created_at)` index did not help, because `status` sits in
the second position and this query does not filter on it.

Added `(branch_id, created_at DESC, id DESC)`. This is why you run EXPLAIN
rather than reasoning about indexes in your head.

### 5.3 Double negation, in the file that warns about double negation

`signedDelta` built a negative with a template literal. Two functions later,
the insufficient-funds check did it again to an already-negative value,
producing `"--49500.0000"`. decimal.js rejected it; the user got a 500 instead
of a clear INSUFFICIENT_FUNDS.

Fixed with `negate()`. The irony is that the file's own comments warn about
exactly this, which is the point: a convention you have to remember is not a
guarantee. The branded `Money` type stops `number` leaking in, but it cannot
stop string concatenation -- so arithmetic must go through functions.

### 5.4 A parameter type, not a syntax error

```
ERROR 42883: function pg_catalog.substring(character varying, bigint) does not exist
```

The voucher-number query used `SUBSTRING(voucher_number FROM $1)`. Prisma binds
a JS number as `bigint`, and there is no `substring(varchar, bigint)`. It reads
like a syntax error and is a parameter-typing problem. Fixed with an explicit
`$1::int`.

### 5.5 Tests that depended on shared mutable fixtures

Three tests passed alone and failed in the full suite; one more failed only on
the second run. They debited seeded accounts whose balances are cumulative
because the database persists between runs.

Rewritten so any test needing money mints its own account. Then verified by
running the suite repeatedly: `run 1 exit=0`, `run 2 exit=0`.

A test that only passes on a fresh database is not a passing test.

---

## 6. Verified behaviour

Full suite: **17 unit + 46 integration**, green, and green again on a rerun
against the same database. `typecheck` clean, `build` clean.

Selected live results:

```
unbalanced voucher      422 VOUCHER_NOT_BALANCED
                        "Debits total 5000.0000 but credits total 4000.0000"
                        details.difference = "1000.0000"

negative amount         422 LINE_AMOUNT_NOT_POSITIVE
                        "Direction is set by drCr, not by a minus sign."

0.30000000000000004     400 VALIDATION_FAILED  (rejected at the edge)

insufficient funds      422 INSUFFICIENT_FUNDS
                        "Account SB101000001 has 49000.0000 available but the
                         voucher needs 49500.0000."
                        + clearedBalance, lienAmount, holdAmount,
                          minimumBalance, overdraftLimit

frozen account, DEBIT   422 ACCOUNT_DEBIT_FROZEN
frozen account, CREDIT  201 posted        <- a salary must still land

cash debit on TL01      422 TRANSACTION_TYPE_NOT_ALLOWED

500 transfer            201 requiredApprovals=0, status=POSTED
25000 transfer          201 requiredApprovals=1, status=PENDING_AUTH
  maker approves it     403 FORBIDDEN details.rule = "four_eyes"
  manager approves it   200 posted=true, status=POSTED

idempotent retry x3     same voucherId every time
                        Idempotency-Replayed: true on attempts 2 and 3
                        rows created: 1
same key, new body      409 CONFLICT
no Idempotency-Key      400 "This endpoint requires an Idempotency-Key header"

reversal                201 contra voucher, every DEBIT became a CREDIT
                        original -> REVERSED, its own lines untouched
reverse twice           422 VOUCHER_NOT_POSTED
```

Concurrency, from the test suite:

- A->B and B->A fired simultaneously: both succeed, no deadlock.
- Five simultaneous 2000 debits against an account with 5000 available: at most
  two succeed, balance never goes below the floor.

And after everything -- 400,407 lines, the bulk load, three full test runs and
a Docker restart:

```
debits 521022018.0000 | credits 521022018.0000 | difference 0.0000
unbalanced vouchers: 0
```

---

## 7. What can fail

| Failure | Response |
|---|---|
| Client retries POST /vouchers | Idempotency key: durable record in Postgres, response replayed |
| Same key, different body | 409. Silently replaying would hide a client bug |
| Two transfers on the same account pair | Locks taken in account-id order; no cycle can form |
| Two checkers approve simultaneously | Voucher row locked FOR UPDATE; unique on (voucher_id, actor_id) |
| Balance moved between creation and approval | Availability is re-checked at posting, not trusted from earlier |
| Lost update on a balance | Optimistic `version` check on top of the row lock; 0 rows affected -> ConcurrencyError |
| Someone bypasses the service layer | CHECK constraints and triggers still refuse it (proven by test) |
| Deferred constraint violation | `SET CONSTRAINTS ALL IMMEDIATE` surfaces it -- see 5.1 |
| Voucher posted to a closed batch | `BATCH_CLOSED`; batches are opened lazily and closed by day-end |
| Voucher posted outside an open day | `DAY_NOT_OPEN` / `DAY_CLOSING`, from the business-date table |
| A mis-dated line | Lands in the DEFAULT partition, which is monitored |
| Statement over a huge range | Keyset paged, partition pruned |
| Outbox row never published | It is durable and PENDING; the Phase 7 relay picks it up, and an alert watches the oldest unsent age |

### Honest gaps at the end of Phase 5

1. **The outbox has no relay yet.** Rows accumulate. That is Phase 7 and is the
   next thing to build.
2. **`cleared_balance` moves with `ledger_balance`.** Cheque clearing is not
   modelled, so the split exists structurally but does nothing yet. When
   clearing arrives it is a service change, not a migration.
3. **No partition-creation job.** Partitions exist to 2027q1. An INSERT with no
   matching partition would land in DEFAULT. Phase 7 adds a worker that creates
   the next one ahead of time.
4. **`audit_event` is defined but not written.** The outbox carries the events;
   the audit writer is a Phase 7 worker.
5. **Interest and charges are not implemented.** They are batch processes and
   belong in Phase 7 with the rest of the async work.
6. **Still no rate limiting**, carried over from Phase 4. Redis, Phase 6.
7. **`balance_after` is written per line from a per-account net**, so on a
   voucher that touches one account twice, both lines show the same final
   figure rather than an intermediate. Correct as a closing balance, slightly
   misleading as a running one. Worth revisiting when statements get real use.

---

## 8. Interview questions this phase should let you answer

1. Walk me through what happens when a teller posts a 25,000 transfer.
2. Two tellers transfer between the same two accounts at the same instant.
   What happens, and why does it not deadlock?
3. Why is the balanced-voucher check a deferred constraint trigger rather than
   a CHECK constraint? What did that decision cost you?
4. You found that Prisma swallows a commit failure. How did you find it, and
   how did you fix it?
5. Why is `amount` always positive with a separate direction column?
6. On a savings account a debit reduces the balance; on a loan account it
   increases it. How do you avoid scattering that logic?
7. What exactly is "available balance"? Why is it not just the balance?
8. Why partition `voucher_line`? What does partitioning cost you?
9. Your statement query prunes to one partition. What happens to a query that
   does not filter on `post_date`?
10. Show me the EXPLAIN difference between OFFSET and keyset pagination at page
    2000. Why is keyset flat at page 8000?
11. Why is the authorisation-queue index partial? How much smaller is it?
12. How do you search customer names? Why can a btree not do it?
13. How do you generate gapless daily voucher numbers? Why not a sequence?
14. A retried POST arrives. Walk me through what happens. What if the body
    differs?
15. Why is the outbox event written in the same transaction? What breaks if you
    publish to the queue inside the transaction instead? What if you publish
    after commit?
16. Why is a correction a new voucher rather than an edit?
17. You check available balance at creation and again at posting. Why twice?
18. Your tests passed individually and failed together. What was wrong, and
    what is the general rule?

---

## 9. Next

**Phase 6 -- Redis.** Cache-aside for the product, GL and permission lookups
that currently hit Postgres on every request; the refresh-token store and
denylist; rate limiting on `/auth/login` (the largest remaining security gap);
distributed locking; and the idempotency fast path. With a measured before and
after, since Phases 3 to 5 deliberately left those costs visible.

**Phase 7 -- async.** The outbox relay, workers, retries with backoff, DLQ, and
the AML rule-worker slice.
