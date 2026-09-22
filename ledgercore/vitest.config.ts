import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests by default -- no database, no network, runnable anywhere.
    // Integration tests (*.int.test.ts) need the docker-compose Postgres and
    // are run separately so a broken local DB never blocks `pnpm test`.
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/**/*.int.test.ts'],
  },
});
