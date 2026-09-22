-- Enforce statement_timeout and lock_timeout at the ROLE level.
--
-- WHY THIS EXISTS
--
-- Phase 10 set these through the connection string's `options` parameter and
-- verified them: `statement_timeout=10s lock_timeout=5s`. Correct at the time.
--
-- Introducing pgBouncer in Phase 11 SILENTLY DISABLED BOTH:
--
--     statement_timeout=0  lock_timeout=0
--
-- pgBouncer's `ignore_startup_parameters` does what it says -- it IGNORES the
-- listed startup parameters rather than forwarding them. `options` has to be
-- listed there or the connection is rejected outright in transaction mode, so
-- the setting is dropped either way.
--
-- Nothing failed. No warning. The only symptom would have been a query that
-- ran forever in production, and a lock wait that froze an account -- the
-- exact failures Phase 10 added those timeouts to prevent.
--
-- Worse, the Phase 10 chaos test kept passing, because it connects DIRECTLY
-- to Postgres while the containers go through pgBouncer. A test that exercises
-- a different path from production proves nothing about production.
--
-- ALTER ROLE is the fix that survives any pooler: Postgres applies it to every
-- session opened by this role, whoever opened it and however it is pooled.
-- The connection-string `options` stay as belt and braces for direct
-- connections (local development, migrations, psql).

ALTER ROLE ledgercore SET statement_timeout = '10s';
ALTER ROLE ledgercore SET lock_timeout = '5s';

-- A long-idle open transaction holds its locks and pins the oldest xmin,
-- which blocks vacuum and bloats the tables. Bounding it is free.
ALTER ROLE ledgercore SET idle_in_transaction_session_timeout = '60s';
