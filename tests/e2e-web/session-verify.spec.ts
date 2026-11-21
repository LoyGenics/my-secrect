/**
 * A stored session token is never trusted on its own: the app checks it
 * with the server before the vault (apps/desktop/src/authGate.ts
 * verifyStoredSession). Revoked -> sign-in, also on the `/?billing` entry
 * (Stripe return URL). Offline: only a token with a known expiry reaches
 * the lock screen; one without a stored expiry stays on sign-in.
 */
import type { Page } from '@playwright/test';
import { test, expect, apiFetch, createVaultViaUi, registerAccountViaUi, storedToken, uniqueEmail, SESSIONS_API } from './fixtures';

const LS_TOKEN_EXPIRES_AT = 'my-secrect:api-token-expires-at';

async function vaultThenRevoke(page: Page, apiUrl: string): Promise<void> {
  await registerAccountViaUi(page, uniqueEmail('verify'));
  await createVaultViaUi(page);
  const token = (await storedToken(page))!;
  const { json } = await apiFetch(apiUrl, token, 'GET', SESSIONS_API);
  const current = json.sessions.find((s: { current: boolean }) => s.current);
  expect((await apiFetch(apiUrl, token, 'DELETE', `${SESSIONS_API}/${current.id}`)).status).toBe(204);
}

test('a revoked stored token is checked at start: back to sign-in, token cleared, no lock screen', async ({ page, apiUrl }) => {
  await vaultThenRevoke(page, apiUrl);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
  await expect(page.getByText(/Your session expired/)).toBeVisible();
  await expect(page.getByText('Your vault is locked')).toHaveCount(0);
  expect(await storedToken(page)).toBeNull();
});

test('the /?billing entry with a revoked token also lands on sign-in', async ({ page, apiUrl }) => {
  await vaultThenRevoke(page, apiUrl);
  await page.goto('/?billing');
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Plan and billing' })).toHaveCount(0);
  expect(await storedToken(page)).toBeNull();
});

test('server unreachable: a token without a stored expiry stays on sign-in; one with a known expiry reaches the lock screen', async ({ page }) => {
  await registerAccountViaUi(page, uniqueEmail('offline'));
  await createVaultViaUi(page);
  const expiresAt = await page.evaluate((k) => localStorage.getItem(k), LS_TOKEN_EXPIRES_AT);
  expect(expiresAt).toMatch(/^\d+$/);
  await page.route('**/v1/auth/sessions', (route) => route.abort('connectionrefused'));

  await page.evaluate((k) => localStorage.removeItem(k), LS_TOKEN_EXPIRES_AT);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
  await expect(page.getByText('Your vault is locked')).toHaveCount(0);
  expect(await storedToken(page)).not.toBeNull(); // kept until it can be verified online

  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [LS_TOKEN_EXPIRES_AT, expiresAt!] as const);
  await page.reload();
  await expect(page.getByText('Your vault is locked')).toBeVisible();
});
