/**
 * No local-only mode: with no account server known (the dev web build has no
 * same-origin default and nothing is saved), the app asks for one before
 * anything else, and only an https or this-machine URL is accepted.
 */
import { test, expect } from './fixtures';

test('no account server: the connect step blocks the vault until a server is entered', async ({ browser, apiUrl, webUrl }) => {
  const context = await browser.newContext({ baseURL: webUrl });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Connect to your account server' })).toBeVisible();
  await expect(page.getByLabel('Master passphrase', { exact: true })).toHaveCount(0);

  const url = page.getByLabel('Account server URL');
  await url.fill('http://vault.example/api');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(/https:\/\//);

  await url.fill(`${apiUrl}/api`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('my-secrect:api-base-url'))).toBe(`${apiUrl}/api`);

  // "Use a different account server" returns to the step; Back keeps the current one.
  await page.getByRole('button', { name: 'Use a different account server' }).click();
  await expect(page.getByLabel('Account server URL')).toHaveValue(`${apiUrl}/api`);
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
  await context.close();
});
