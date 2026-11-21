import { defineConfig } from '@playwright/test';

/**
 * Accessibility check against the REAL production web build:
 * `npm --workspace apps/web run build` then `vite preview`. Every vault needs
 * an account, so global-setup.ts boots the real Rails API (own *_e2eauth DB)
 * and `vite preview` proxies the app's same-origin `/api` to it. Ports via
 * A11Y_WEB_PORT (default 5314) and A11Y_API_PORT (default 3121).
 *
 * Run: npm run test:a11y:web
 */
const port = Number(process.env.A11Y_WEB_PORT ?? 5314);
const apiPort = Number(process.env.A11Y_API_PORT ?? 3121);

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  globalSetup: './global-setup.ts',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    baseURL: `http://localhost:${port}`,
    browserName: 'chromium',
    // Full Chromium (new headless): chrome-headless-shell turns on macOS Secure
    // Input on password fields, which blocks keyboard input methods system-wide.
    channel: 'chromium',
    locale: 'en-US',
  },
  webServer: {
    command: `npm --workspace apps/web run build && VITE_API_PROXY_TARGET=http://127.0.0.1:${apiPort} npm --workspace apps/web exec -- vite preview --port ${port} --strictPort`,
    cwd: '../..',
    url: `http://localhost:${port}`,
    timeout: 240_000,
    reuseExistingServer: false,
  },
});
