import { defineConfig } from 'vitest/config';

// Root-level config, scoped to scripts/ tests only. daemon/server/extension
// each own their own vitest.config.ts and are run via their own `npm test`.
export default defineConfig({
  test: {
    globals: true,
    include: ['scripts/**/*.test.ts'],
  },
});
