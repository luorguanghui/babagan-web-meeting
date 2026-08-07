import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'api',
          environment: 'node',
          include: ['apps/api/src/**/*.test.ts'],
          exclude: ['**/dist/**']
        }
      },
      {
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['apps/web/src/**/*.test.tsx'],
          exclude: ['**/dist/**']
        }
      }
    ]
  }
});
