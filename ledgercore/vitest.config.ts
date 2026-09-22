import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests by default -- no database, no network.
    // Integration tests (*.int.test.ts) need the docker-compose Postgres and
    // both Redis roles, and are run separately so a broken local DB never
    // blocks `pnpm test`.
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/**/*.int.test.ts'],

    // This block exists because of the FIRST real CI run, which failed with:
    //
    //   Error: process.exit unexpectedly called with "1"
    //     src/config/index.ts:97
    //     src/shared/logging/logger.ts:2
    //
    // resilience.test.ts imports the circuit breaker, which imports the
    // logger, which imports config -- and config validates process.env with
    // zod and calls process.exit(1) when DATABASE_URL or JWT_SECRET is absent.
    //
    // It passed on every developer machine because Vitest loads `.env` from
    // disk into process.env, and `.env` is gitignored. The suite's
    // hermeticity was propped up by an untracked file. A fresh clone would
    // have failed identically -- CI is simply the first environment honest
    // enough to BE a fresh clone, every time.
    //
    // Declaring the env HERE makes the unit suite depend on the repository
    // rather than on the machine. The values are deliberately unusable: port 1
    // guarantees that a unit test which ever reached for a database would fail
    // loudly instead of quietly connecting to a real one.
    //
    // NOTE on LOG_LEVEL: the first attempt used 'silent', which is not in the
    // zod enum (fatal|error|warn|info|debug|trace). Config rejected it and
    // exited 1 -- the SAME stack trace as the bug being fixed, which makes it
    // very easy to conclude "the fix did not apply". It had applied; it was
    // wrong. The actual reason was on stderr the whole time, in the message
    // config prints before exiting.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      DATABASE_URL: 'postgresql://unit:unit@localhost:1/unit-tests-never-connect',
      JWT_SECRET: 'unit-test-secret-not-used-for-anything-at-all',
    },
  },
});
