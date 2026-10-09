import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'packages/**/*.test.ts',
      'apps/**/*.test.ts',
      'apps/web/src/report/business-evidence-connection.test.tsx',
    ],
  },
});
