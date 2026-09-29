import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The pinning tests assert release-binary behaviour; a dev build's @latest
  // fallback is covered by the npmTag unit tests.
  define: { __SUPERSURF_VERSION__: JSON.stringify('9.9.9-test') },
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
  },
});
