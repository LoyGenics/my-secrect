/**
 * Sign-up email ownership, end to end: the code is read from the message
 * the real API delivered (stack.ts :file delivery = the inbox), typed into
 * the real UI, and the real server verifies it before any account exists.
 */
import {
  test, expect, uniqueEmail, registerAccountViaUi, mailCodes, mailText, waitForMailCode,
  apiFetch, storedToken, newVirtualAuthenticator, LS_API_BASE_URL,
} from './fixtures';

function otherCode(code: string): string {
  return String((Number(code) + 1) % 1_000_000).padStart(6, '0');
}

async function startSignUp(page: import('@playwright/test').Page, email: string) {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Account email').fill(email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

test.describe('sign-up email verification', () => {
  test('a wrong code is refused; the mailed code creates the account', async ({ page, authenticator, apiUrl }) => {
    const email = uniqueEmail('signup');
    await startSignUp(page, email);
    const code = await waitForMailCode(email);

    await page.getByLabel('Verification code').fill(otherCode(code));
    await page.getByRole('button', { name: 'Create account with passkey' }).click();
    await expect(page.getByText('That code did not work.', { exact: false })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    expect(await authenticator.credentials()).toHaveLength(0); // no ceremony ran
    expect(await storedToken(page)).toBeNull();

    await page.getByLabel('Verification code').fill(code);
    await page.getByRole('button', { name: 'Create account with passkey' }).click();
    await expect(page.getByText('Create your local vault')).toBeVisible();
    expect(await authenticator.credentials()).toHaveLength(1);
    const token = await storedToken(page);
    expect((await apiFetch(apiUrl, token, 'GET', '/api/v1/auth/sessions')).status).toBe(200);

    // The code is single-use: replaying it against the API fails.
    const replay = await apiFetch(apiUrl, null, 'POST', '/api/v1/auth/email/verify', { email, code });
    expect(replay.status).toBe(401);
  });

  test('a new code replaces the previous one', async ({ page, authenticator }) => {
    const email = uniqueEmail('resend');
    await startSignUp(page, email);
    const first = await waitForMailCode(email);
    await page.getByRole('button', { name: 'Send a new code' }).click();
    const second = await waitForMailCode(email, 1);
    test.skip(first === second, 'the two random codes collided (1 in a million)');

    await page.getByLabel('Verification code').fill(first);
    await page.getByRole('button', { name: 'Create account with passkey' }).click();
    await expect(page.getByText('That code did not work.', { exact: false })).toBeVisible();

    await page.getByLabel('Verification code').fill(second);
    await page.getByRole('button', { name: 'Create account with passkey' }).click();
    await expect(page.getByText('Create your local vault')).toBeVisible();
    expect(await authenticator.credentials()).toHaveLength(1);
  });

  test('an address that already has an account gets the same answer and a notice, never a code', async ({ page, authenticator, apiUrl, browser }) => {
    const email = uniqueEmail('taken');
    await registerAccountViaUi(page, email);
    const codesBefore = mailCodes(email).length;

    const fresh = await apiFetch(apiUrl, null, 'POST', '/api/v1/auth/email/request', { email: uniqueEmail('fresh') });
    const taken = await apiFetch(apiUrl, null, 'POST', '/api/v1/auth/email/request', { email });
    expect(taken.status).toBe(fresh.status);
    expect(taken.json).toEqual(fresh.json);

    // Same screen in a fresh browser, too.
    const context = await browser.newContext();
    const other = await context.newPage();
    await other.addInitScript(([key, url]) => {
      try { if (localStorage.getItem(key) === null) localStorage.setItem(key, url); } catch { /* ignore */ }
    }, [LS_API_BASE_URL, `${apiUrl}/api`]);
    await newVirtualAuthenticator(other);
    await startSignUp(other, email);
    await context.close();

    await expect.poll(() => (mailText(email).match(/An account already exists for it/g) ?? []).length).toBe(2);
    expect(mailCodes(email)).toHaveLength(codesBefore);
    // Without a ticket the server hands out no creation options.
    expect((await apiFetch(apiUrl, null, 'POST', '/api/v1/auth/passkeys/register', { email })).status).toBe(401);
  });
});
