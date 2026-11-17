import { defineConfig } from '@playwright/test';
import { stackConfigFromEnv } from './stack';

const { webPort } = stackConfigFromEnv();

// One real Rails API + Vite web app per run (global-setup.ts). Specs create
// unique accounts, so files may run in parallel; each test gets its own
// browser context (own localStorage + own virtual authenticator).
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  globalSetup: './global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    baseURL: `http://localhost:${webPort}`,
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
