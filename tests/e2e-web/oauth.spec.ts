/**
 * "Continue with Google" / "Continue with Apple" on the web sign-in screen.
 *
 * Honest scope: real Google / Apple sign-in cannot run here (no client ids,
 * no IdP). These specs MOCK the three OAuth endpoints and replace the two
 * provider scripts with stubs, so they check the client wiring only: which
 * buttons show, that the nonce from auth/oauth/start reaches the provider
 * (raw for Google, SHA-256 hex for Apple), and that the ID token, ticket and
 * device proof go to auth/oauth/:provider/session. The server-side token
 * verification is covered by the API's own specs. Without mocks, the real
 * API's provider answer hides both buttons (first test).
 */
import { createHash } from 'node:crypto';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

const NONCE = 'raw-nonce-0123456789';
const TICKET = 'oauth-ticket-abc';

function fakeIdToken(email: string): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'RS256', kid: 'test' })}.${part({ email, sub: '123', nonce: NONCE })}.c2ln`;
}

async function mockOAuthApi(page: Page, providers: unknown) {
  const sessions: Array<{ url: string; body: any }> = [];
  await page.route('**/v1/auth/providers', (route) => route.fulfill({ json: providers }));
  await page.route('**/v1/auth/oauth/start', (route) =>
    route.fulfill({ json: { ticket: TICKET, nonce: NONCE, expires_at: new Date(Date.now() + 600_000).toISOString() } }));
  await page.route('**/v1/auth/oauth/*/session', (route) => {
    sessions.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return route.fulfill({ json: { token: `sess_${'0'.repeat(64)}`, user_id: 'u1', device_id: null, expires_in: 3600 } });
  });
  // The app reloads after sign-in and verifies the stored session first.
  await page.route('**/v1/auth/sessions', (route) => route.fulfill({ json: { sessions: [{ id: 's1', current: true }] } }));
  return sessions;
}

test('the real API lists no provider: only email sign-in is offered', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
  await expect(page.getByLabel('Account email')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Apple' })).toHaveCount(0);
  await expect(page.getByTestId('google-button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Continue without signing in/ })).toHaveCount(0);
});

test('Apple (mocked IdP): hashed nonce to Apple, ID token + ticket + device proof to the API', async ({ page }) => {
  const sessions = await mockOAuthApi(page, { google: null, apple: { services_id: 'com.example.web', bundle_id: null } });
  const email = 'apple-user@privaterelay.appleid.com';
  await page.route('https://appleid.cdn-apple.com/**', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `window.AppleID = { auth: {
      init(cfg) { window.__appleCfg = cfg; sessionStorage.setItem('appleCfg', JSON.stringify(cfg)); },
      signIn() { return Promise.resolve({ authorization: { id_token: ${JSON.stringify(fakeIdToken(email))}, state: window.__appleCfg.state }, user: { name: { firstName: 'Ann', lastName: 'Lee' } } }); },
    } };`,
  }));
  await page.goto('/');
  await expect(page.getByTestId('google-button')).toHaveCount(0);
  const apple = page.getByRole('button', { name: 'Continue with Apple' });
  await expect(apple).toBeEnabled();
  await apple.click();
  await expect(page.getByRole('heading', { name: 'Create passphrase', level: 1 })).toBeVisible();
  // The page reloaded after sign-in: Apple's script is gone from the vault page.
  expect(await page.evaluate(() => [typeof (window as any).AppleID, document.querySelectorAll('script[src*="appleid"]').length])).toEqual(['undefined', 0]);

  const cfg = await page.evaluate(() => JSON.parse(sessionStorage.getItem('appleCfg') ?? 'null'));
  expect(cfg.nonce).toBe(createHash('sha256').update(NONCE).digest('hex'));
  expect(cfg.clientId).toBe('com.example.web');
  expect(cfg.usePopup).toBe(true);
  expect(sessions).toHaveLength(1);
  expect(sessions[0].url).toMatch(/\/v1\/auth\/oauth\/apple\/session$/);
  expect(sessions[0].body).toMatchObject({ ticket: TICKET, id_token: fakeIdToken(email), full_name: 'Ann Lee' });
  expect(sessions[0].body.device.signature).toMatch(/^[A-Za-z0-9_-]+$/);
});

test('Google (mocked IdP): raw nonce to Google, ID token + ticket + device proof to the API', async ({ page }) => {
  const sessions = await mockOAuthApi(page, { google: { web_client_id: 'web.apps.googleusercontent.com' }, apple: null });
  const email = 'g-user@example.test';
  await page.route('https://accounts.google.com/gsi/client', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `window.google = { accounts: { id: {
      initialize(cfg) { window.__gCfg = cfg; sessionStorage.setItem('gCfg', JSON.stringify({ nonce: cfg.nonce, client_id: cfg.client_id })); },
      renderButton(el) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = 'Google stub';
        b.onclick = () => window.__gCfg.callback({ credential: ${JSON.stringify(fakeIdToken(email))} });
        el.appendChild(b);
      },
    } } };`,
  }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Continue with Apple' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Google stub' }).click();
  await expect(page.getByRole('heading', { name: 'Create passphrase', level: 1 })).toBeVisible();
  // The page reloaded after sign-in: Google's script is gone from the vault page.
  expect(await page.evaluate(() => [typeof (window as any).google, document.querySelectorAll('script[src*="accounts.google.com"]').length])).toEqual(['undefined', 0]);

  const cfg = await page.evaluate(() => JSON.parse(sessionStorage.getItem('gCfg') ?? 'null'));
  expect(cfg.nonce).toBe(NONCE);
  expect(cfg.client_id).toBe('web.apps.googleusercontent.com');
  expect(sessions).toHaveLength(1);
  expect(sessions[0].url).toMatch(/\/v1\/auth\/oauth\/google\/session$/);
  expect(sessions[0].body).toMatchObject({ ticket: TICKET, id_token: fakeIdToken(email) });
  expect(sessions[0].body.full_name).toBeUndefined();
  expect(sessions[0].body.device.signature).toMatch(/^[A-Za-z0-9_-]+$/);
});

test('Apple (mocked IdP): an answer with another attempt\'s state is refused', async ({ page }) => {
  const sessions = await mockOAuthApi(page, { google: null, apple: { services_id: 'com.example.web', bundle_id: null } });
  await page.route('https://appleid.cdn-apple.com/**', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `window.AppleID = { auth: {
      init() {},
      signIn() { return Promise.resolve({ authorization: { id_token: ${JSON.stringify(fakeIdToken('x@example.test'))}, state: 'someone-else' } }); },
    } };`,
  }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with Apple' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
  expect(sessions).toHaveLength(0);
});
