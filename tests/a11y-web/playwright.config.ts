import { defineConfig } from '@playwright/test';

/**
 * Accessibility check against the REAL production web build:
 * `npm --workspace apps/web run build` then `vite preview`. No server or
 * account is needed (local-only vault). Port via A11Y_WEB_PORT (default 5314).
 *
 * Run: npm run test:a11y:web
 */
const port = Number(process.env.A11Y_WEB_PORT ?? 5314);

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    baseURL: `http://localhost:${port}`,
    browserName: 'chromium',
    locale: 'en-US',
  },
  webServer: {
    command: `npm --workspace apps/web run build && npm --workspace apps/web exec -- vite preview --port ${port} --strictPort`,
    cwd: '../..',
    url: `http://localhost:${port}`,
    timeout: 240_000,
    reuseExistingServer: false,
  },
});
