# Phase 4 -- Authentication in Full

> Built and verified on 2026-09-21. Extends Phase 3.
> Still Step-1 topology: no Redis, no queue. Refresh tokens live in Postgres.

---

## 1. What we built

```
  POST /api/v1/auth/login              staff code + password -> access token + refresh cookie
  POST /api/v1/auth/refresh            rotate: new access token + new refresh cookie
  POST /api/v1/auth/logout             revoke this session's family
  GET  /api/v1/auth/sessions           one row per login, not per token
  POST /api/v1/auth/sessions/revoke-all logout everywhere
  POST /api/v1/auth/change-password    policy + revoke every session
  GET  /api/v1/auth/me                 current actor and permissions
```

New files: `refreshToken.service.ts`, `refreshToken.repository.ts`,
`passwordPolicy.ts`. New table: `refresh_token`. New enum: `revoke_reason`.

---

## 2. The design, decision by decision

### 2.1 Two tokens, two storage locations, for one reason

| | Access token | Refresh token |
|---|---|---|
| Format | JWT (HS256) | 32 bytes of CSPRNG output, opaque |
| Lifetime | 15 minutes | 7 days absolute |
| Stored where (server) | nowhere | `refresh_token`, as SHA-256 |
| Stored where (client) | JS memory | httpOnly cookie |
| Revocable | indirectly (see 2.4) | yes, immediately |

The split exists for exactly one reason: **an XSS payload must not be able to
steal the long-lived credential.** The access token is reachable from
JavaScript but expires in 15 minutes. The refresh token lasts a week and is
`httpOnly`, so script cannot read it at all.

Putting both in `localStorage` -- the common shortcut -- means one XSS gives an
attacker a week of access.

### 2.2 The refresh token is not a JWT

**Problem.** Need a long-lived credential that can be revoked.

**Options.** (a) a second JWT, which is what the legacy system did;
(b) an opaque random token backed by a database row.

**Chosen.** (b).

**Why.** A JWT is self-validating, which is precisely wrong here: it cannot be
un-issued. Revocation would need a denylist, at which point you have a database
lookup anyway and the JWT bought nothing. The legacy "refresh token" was a JWT
from the same secret with a longer expiry -- no id, no store, no revocation.
Logout was `window.location.reload()`, which invalidated nothing at all.

**Trade-off.** Every refresh costs a database round trip. That is the point:
the round trip is what makes revocation possible. It happens once per 15
minutes per user, not once per request.

### 2.3 Rotation with reuse detection

Every refresh mints a new token and retires the old one. Tokens descended from
one login share a `familyId` -- **the family is the session**.

```
  login  -> T1
  refresh(T1) -> T2     T1 marked used, replaced_by = T2
  refresh(T2) -> T3     T2 marked used, replaced_by = T3
  refresh(T1) -> ???    T1 is already used. Someone has a copy.
                        -> revoke the ENTIRE family. T3 dies too.
```

Revoking only T1 would be useless: whoever holds T3 -- possibly the attacker --
keeps a working session. Burning the family forces both parties back to the
login screen, where only the one who knows the password gets back in.

**Rotation is strict: no grace window.** I built one first and removed it.
Every version of a grace window forks the family: the successor's plaintext was
never stored so it cannot be re-issued, and minting a second token leaves two
live chains from one login -- the exact state reuse detection exists to
prevent. A window that reintroduces the hole it is meant to soften is not a
trade-off, it is a bug with a comment.

**The honest cost.** Two tabs refreshing simultaneously, or a response lost in
flight and retried, look identical to theft and log the user out. The fix
belongs on the client: refreshes must be single-flight -- one in-flight request
shared by every waiting caller. That is a small mutex in the API client, and it
is where the problem actually is. For a banking back-office the asymmetry is
clear anyway: an unnecessary re-login costs fifteen seconds, a missed session
hijack costs considerably more.

### 2.4 Revoking an access token without a denylist

A stateless JWT cannot be revoked. But after a password change, every
outstanding access token *must* stop working -- otherwise a user who changes
their password because they think it was stolen leaves the attacker up to 15
minutes of continued access.

**Chosen.** The token carries a `pwd` claim: the user's `passwordChangedAt` in
epoch milliseconds at the moment of minting. `authenticate` compares it against
the user's current value and refuses any mismatch. One field comparison, no
storage, no lookup -- `authenticate` already loads the user.

**What I tried first, and why it failed.** Compare the standard `iat` claim
against `passwordChangedAt`. An integration test caught it: `iat` is whole
SECONDS, `passwordChangedAt` has sub-second precision, so a token minted at
12:29:41.500 and a password changed at 12:29:41.900 are indistinguishable and
the stale token survived. Adding slack to absorb the truncation just moved the
hole to the other side. An explicit claim compared for exact equality has no
edge case.

### 2.5 Cookie attributes, and what each one stops

```
  httpOnly              script cannot read it -> XSS cannot exfiltrate it
  secure                HTTPS only (off in dev: browsers silently drop a
                        Secure cookie over http, which breaks the local loop)
  sameSite=strict       browser will not attach it cross-site -> CSRF defence
  path=/api/v1/auth     an ordinary business call never carries it, so it
                        cannot leak through a logging proxy on some other route
```

**CSRF trade-off, stated plainly.** `SameSite=Strict` is the whole defence
here. It is strong in every browser this system supports, and the attack
surface is three routes rather than the entire API because of the cookie path.
A double-submit CSRF token would be belt and braces; it is not implemented, and
that is a deliberate, named gap rather than an oversight.

### 2.6 Password policy: NIST, not the 2003 convention

`passwordPolicy.ts` follows NIST SP 800-63B:

- minimum **12** characters -- length dominates
- **no composition rules** (no "one uppercase, one digit, one symbol"). They
  produce `Password1!` and sticky notes, not entropy
- block passwords containing the user's own staff code, name or email
- block a small deny-list of obvious choices
- **no forced periodic rotation** -- it measurably produces `Passw0rd1` ->
  `Passw0rd2`. Rotation is triggered by evidence of compromise instead

`MAX_PASSWORD_AGE_DAYS` exists and is set to `null`, with a comment: a bank
auditor may demand 90-day rotation regardless of the evidence, and that
conversation is better had pointing at a knob than at a rewrite.

Note: the dev seed password `ChangeMe#2026` **is on the deny list**. A test
that tried to restore it got a 422. The policy was right and the test was
wrong -- see section 4.

### 2.7 Transparent hash upgrade

On successful login, if the stored hash used weaker parameters than current
(`needsRehash`), it is rehashed right there -- while we legitimately hold the
plaintext. This is the mechanism that makes a future scrypt -> argon2id move a
per-user migration with no flag day and no forced reset.

Critically it passes `touchChangedAt: false`. A hash upgrade is not a
credential change and must not sign the user out of their other devices.

---

## 3. Verified behaviour

All executed against the running API and a real Postgres.

**Where the refresh token lives:**

```
Set-Cookie: lc_rt=XzqFmGennSZtOmfpa8xi5kXR...  Path=/api/v1/auth; HttpOnly; SameSite=Strict

response body:
{ "accessToken": "eyJhbGciOiJIUzI1NiIsInR5...", "expiresIn": 900,
  "tokenType": "Bearer", "mustChangePassword": false,
  "user": { "staffCode": "O001", "roleCode": "OFFICER", "branchCode": 101, ... } }
```

The refresh token appears nowhere in the body. A test asserts this, because a
well-meaning "let me also return it for convenience" would silently undo
`httpOnly`.

**Reuse detection, end to end:**

```
1. login M001                     -> T1 in cookie
2. refresh with T1                -> HTTP 200, rotated to T2  (T1 != T2 asserted)
3. attacker replays T1            -> HTTP 401 {"reason":"reuse_detected"}
4. legitimate session refreshes T2-> HTTP 401 {"reason":"revoked"}   <- family burned
```

Server log for step 3:

```
level   : error
msg     : REFRESH TOKEN REUSE DETECTED -- family revoked, every session in it killed
familyId: 9dd56e43-fe90-41a5-9af6-3f6fe0a42da8
revoked : 1 tokens
reqId   : a142fcbe-ac53-40d6-af8d-11b611a1589c
```

Logged at **error**, not warn: this is the signal a token leaked. It should
page someone, and in Phase 9 it becomes a metric.

**Tests:** 17 unit + 23 integration, all passing. `typecheck` clean.

Integration coverage: cookie attributes; refresh token absent from the body;
only a SHA-256 hash in the database; rotation issues a different token;
unknown token rejected; missing cookie rejected; reuse burns the family
including the legitimate successor; logout kills the session and is idempotent;
logout works without a valid access token; sessions list one row per login
after two rotations; wrong current password rejected; policy rejects a password
containing the staff code; policy rejects reusing the current password;
password change kills another device's access token AND refresh token.

---

## 4. Three real bugs, and what each one teaches

### 4.1 The security action rolled back

The reuse path revoked the family and then threw `UnauthorizedError` -- both
inside `prisma.$transaction`. **Throwing out of a transaction rolls it back**,
so the revocation was undone. The attacker got a 401 and kept a working
session: the detection was theatre.

The integration test caught it by asserting the *legitimate successor* was also
dead. It came back 200.

Fix: the transaction **returns** a `{ kind: 'reject', reason }` outcome instead
of throwing. The caller converts it to an error after the commit.

The general lesson: a side effect that must survive a rejection cannot share a
transaction with the rejection.

### 4.2 Second-granularity comparison on a sub-second event

Section 2.4. `iat` truncation made a same-second password change unable to
invalidate a token.

### 4.3 A test that depended on restoring shared fixture data

The password-change test mutated a seeded user and tried to set the password
back afterwards. It failed with `422 PASSWORD_TOO_COMMON`, because the seed
password is on the deny list.

The policy was correct; the test was badly designed. Rewritten to create and
destroy its own `ZZTEST1` user. A suite must not depend on being able to put
shared fixtures back.

---

## 5. What can fail

| Failure | Response |
|---|---|
| Refresh token stolen and used | Legitimate client's next refresh trips reuse detection; family burned; both parties must re-login |
| Refresh token stolen and NOT used | Rotation means the thief's copy is retired the moment the real client refreshes -- the window is one refresh interval |
| Access token stolen | Valid up to 15 minutes. Cannot be individually revoked; a password change kills it immediately via `pwd` |
| Database leak | Only SHA-256 hashes of refresh tokens and scrypt hashes of passwords. No usable session falls out |
| Two tabs refresh at once | One wins, the other trips reuse detection, user re-logs in. Client-side single-flight is the fix |
| Refresh concurrently with the same token | `SELECT ... FOR UPDATE` serialises them; the second sees `usedAt` set |
| User disabled mid-session | Next request fails: `resolveActor` reads live status |
| User's role changed | Next request uses the new permissions; nothing is cached yet |
| Password changed on another device | Both the access token (`pwd` mismatch) and the refresh token (revoked) die |
| `refresh_token` table grows | `purgeExpired()` exists; becomes a scheduled worker job in Phase 7 |

### Honest gaps at the end of Phase 4

1. **Still no rate limiting on `/auth/login`.** The per-account lockout stops
   credential stuffing against ONE account but not password spraying across
   many. Needs Redis. Phase 6. This is the largest remaining hole.
2. **No CSRF token.** `SameSite=Strict` plus the cookie path is the whole
   defence. Documented, not hidden.
3. **`purgeExpired` is not scheduled.** Phase 7.
4. **No MFA.** Out of scope for the brief, but it is what a real CBS would need
   for privileged roles, and it is the obvious next thing an interviewer asks.
5. **`mustChangePassword` is surfaced but not enforced.** A user with the flag
   set can still use the API. Enforcing it means a middleware that blocks every
   route except change-password.

---

## 6. Interview questions this phase should let you answer

1. Why is the access token in memory and the refresh token in a cookie? What
   attack does each placement defeat?
2. Why is the refresh token not a JWT?
3. Explain rotation with reuse detection. Why revoke the whole family rather
   than just the replayed token?
4. A user has two tabs open and both refresh at the same time. What happens,
   and whose problem is it to fix?
5. You store SHA-256 of the refresh token but scrypt of the password. Why the
   different algorithms?
6. A JWT cannot be revoked. So how does your password change invalidate an
   access token issued two minutes ago?
7. You revoke the token family and then return 401. Why can those two things
   not be in the same database transaction?
8. Why no forced 90-day password rotation? What would you say to an auditor who
   insists on it?
9. What stops CSRF on your refresh endpoint? What are you NOT doing that you
   could?
10. Your login endpoint has no rate limit. Is that not a serious problem?
    (Expected answer: yes, and it is named -- per-account lockout covers
    stuffing against one account but not spraying. It needs Redis, which
    arrives in Phase 6.)
11. How would you migrate from scrypt to argon2id without forcing every user to
    reset their password?

---

## 7. Next

**Phase 5 -- Database engineering and the ledger.** ER diagram, the posting
schema (product, account, account_balance, voucher, voucher_line,
authorization_step, idempotency_key, outbox), partitioning, composite and
partial indexes, transactions with explicit row locks and deadlock-safe
ordering, optimistic concurrency, keyset pagination on the ledger, and
slow-query -> EXPLAIN -> index -> improved-query walkthroughs.

This is the phase the whole project exists for.
