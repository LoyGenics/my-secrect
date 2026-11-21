import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// The real stack from tests/e2e-web (Rails API + Postgres + Vite web app),
// on its own ports and database so it never collides with the web e2e run.
// stack.ts drops and recreates the database and requires the _e2eauth suffix.
process.env.E2E_API_PORT ??= '3222';
process.env.E2E_WEB_PORT ??= '5322';
process.env.E2E_DB_NAME ??= 'vault_a10_e2eauth';
process.env.E2E_LOG_DIR ??= path.join(here, '.out', 'stack-logs');

export default defineConfig({
  testDir: '.',
  testMatch: /(?:family-)?ui\.spec\.ts/,
  globalSetup: '../e2e-web/global-setup.ts',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: './.out/test-results',
  use: {
    baseURL: `http://localhost:${process.env.E2E_WEB_PORT}`,
    browserName: 'chromium',
    // Full Chromium (new headless): chrome-headless-shell turns on macOS Secure
    // Input on password fields, which blocks keyboard input methods system-wide.
    channel: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
