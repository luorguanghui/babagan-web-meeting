import { defineConfig, devices } from '@playwright/test';

/**
 * Local mode is the default: Playwright boots the API (with a fake LiveKit
 * media service) and serves the built web app on one origin via
 * `apps/api/test/local-e2e-server.ts`. Set E2E_BASE_URL to point at a
 * deployment (and E2E_ADMIN_PASSWORD) to run against a real stack instead.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080';
const localMode = process.env.E2E_BASE_URL === undefined;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  webServer: localMode ? [{
    command: 'pnpm --filter @meeting/contracts build && pnpm --filter @meeting/web exec vite build && pnpm --filter @meeting/api exec tsx test/local-e2e-server.ts',
    url: 'http://127.0.0.1:8080/health/live',
    timeout: 180_000,
    reuseExistingServer: true
  }] : undefined,
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chrome',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
        launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }
      }
    },
    {
      name: 'edge',
      use: {
        ...devices['Desktop Edge'],
        channel: 'msedge',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
        launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }
      }
    }
  ]
});
