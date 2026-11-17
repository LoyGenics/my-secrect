import { defineConfig } from '@playwright/test';

// One real Chromium persistent context shared by the serial specs.
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  reporter: [['list']],
  outputDir: '../node_modules/.cache/e2e-results',
});
