/**
 * Sharing through the REAL web UI (apps/web renders the desktop App and
 * SharesView) in two independent Chromium contexts against the real Rails
 * API. Each user registers with a genuine passkey (CDP virtual
 * authenticator, verified by the server), creates a vault through
 * onboarding and uses only what a person sees on screen. The fingerprint
 * "read aloud" is the digits on B's screen compared with the digits on A's.
 *
 * Run: npx playwright test -c tests/sharing-e2e/playwright.config.ts
 */
import type { Browser, Page } from '@playwright/test';
import {
  expect,
  LS_API_BASE_URL,
  newVirtualAuthenticator,
  signedInWithVault,
  stepUpWithPasskey,
  test,
  uniqueEmail,
} from '../e2e-web/fixtures';

const TITLE = 'MARK-UI-ROUTER-5c5c';
const PASSWORD = 'MARK-UI-PW-8d8d';

async function freshBrowser(browser: Browser, apiUrl: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(([key, url]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, url); } catch { /* ignore */ }
  }, [LS_API_BASE_URL, `${apiUrl}/api`]);
  await newVirtualAuthenticator(page);
  return page;
}

/** Open (or re-open, which reloads the share list) the Sharing view. */
async function openSharing(page: Page): Promise<string> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Sharing/ }).click();
  const fp = page.getByTestId('my-fingerprint');
  await expect(fp).toHaveText(/^\d{5}( \d{5}){5}$/);
  return (await fp.innerText()).trim();
}

/** First visit: creating the sharing key needs a server step-up (passkey). */
async function createSharingKey(page: Page): Promise<string> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Sharing/ }).click();
  await expect(page.getByText('Creating your sharing key needs a fresh verification')).toBeVisible();
  await expect(page.getByTestId('my-fingerprint')).toHaveCount(0);
  await page.getByRole('button', { name: 'Verify it’s you' }).click();
  await stepUpWithPasskey(page);
  const fp = page.getByTestId('my-fingerprint');
  await expect(fp).toHaveText(/^\d{5}( \d{5}){5}$/);
  return (await fp.innerText()).trim();
}

test('A shares an item read-only with B through the UI; B verifies, accepts, opens; A revokes', async ({ page, authenticator, apiUrl, browser }) => {
  void authenticator; // attaches the virtual authenticator to A's page
  const emailA = uniqueEmail('share-a');
  const emailB = uniqueEmail('share-b');
  const pageB = await freshBrowser(browser, apiUrl);

  await signedInWithVault(page, { email: emailA });
  await signedInWithVault(pageB, { email: emailB });
  const fingerprintB = await createSharingKey(pageB);

  // A creates an item.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Vault' }).click();
  await page.getByRole('button', { name: /^New item/ }).click();
  await page.locator('#item-title').fill(TITLE);
  await page.getByLabel('Username').fill('alice');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(TITLE).first()).toBeVisible();

  // A looks B up, compares the digits with B's screen, verifies and shares.
  const fingerprintA = await createSharingKey(page);
  await page.getByLabel('Item', { exact: true }).selectOption({ label: TITLE });
  await page.getByLabel('Recipient email').fill(emailB);
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(page.getByTestId('recipient-fingerprint')).toHaveText(fingerprintB);
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Every digit matches — verify' }).click();
  await expect(page.getByText('Verified on this device.')).toBeVisible();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByText(`Shared. ${emailB} must verify your key`)).toBeVisible();
  await expect(page.getByText(`To ${emailB}`)).toBeVisible();

  // B sees the pending share, verifies A's digits, accepts and opens it.
  await openSharing(pageB);
  // Unverified: the email is labelled as only what the server says.
  await expect(pageB.getByText(`From ${emailA} (as the server reports it — not verified)`, { exact: true })).toBeVisible();
  await expect(pageB.getByRole('button', { name: 'Open', exact: true })).toHaveCount(0);
  await pageB.getByRole('button', { name: `Verify ${emailA}’s key` }).click();
  await expect(pageB.getByText(fingerprintA)).toBeVisible();
  await pageB.getByRole('button', { name: 'Every digit matches — verify' }).click();
  await expect(pageB.getByText(`From ${emailA}`, { exact: true })).toBeVisible(); // now the pinned email
  await pageB.getByRole('button', { name: 'Verify key exchange and accept' }).click();
  await expect(pageB.getByText(`Accepted. The key exchange verified with ${emailA}’s key.`)).toBeVisible();
  await pageB.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(pageB.getByRole('heading', { name: TITLE })).toBeVisible();
  await expect(pageB.getByText(PASSWORD)).toHaveCount(0); // masked until revealed
  await pageB.getByRole('button', { name: 'Reveal', exact: true }).click();
  await expect(pageB.getByText(PASSWORD)).toBeVisible();
  await expect(pageB.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0); // read-only

  // A revokes; B can no longer open it.
  await openSharing(page);
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm revoke' }).click();
  await expect(page.getByText('Share revoked.')).toBeVisible();
  await openSharing(pageB);
  await expect(pageB.getByText(/ · revoked · /).first()).toBeVisible();
  await expect(pageB.getByRole('button', { name: 'Open', exact: true })).toHaveCount(0);

  await pageB.context().close();
});
