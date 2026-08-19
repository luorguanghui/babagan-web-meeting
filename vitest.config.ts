import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    projects: [
      {
        test: {
          name: 'contracts',
          environment: 'node',
          include: ['packages/contracts/src/**/*.test.ts'],
          exclude: ['**/dist/**']
        }
      },
      {
        test: {
          name: 'api',
          environment: 'node',
          include: ['apps/api/src/**/*.test.ts', 'apps/api/test/**/*.test.ts'],
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
