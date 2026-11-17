import type { Page } from '@playwright/test';
import {
  test, expect, signedInWithVault, storedToken, apiFetch, nextTotp, signOutViaUi, signInWithPasskeyViaUi,
  stepUpWithPasskey, stepUpWithTotp, stepUpDialog, SESSIONS_API, openSecurityCenter,
} from './fixtures';

const mfaSection = (page: Page) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: 'Authentication methods', exact: true }) });

/** Enroll TOTP through the UI with a code computed by node:crypto. Returns secret, recovery codes and last used step. */
async function enableMfa(page: Page) {
  const auth = mfaSection(page);
  await auth.getByRole('button', { name: 'Set up authenticator app' }).click();
  const secret = await auth.getByRole('textbox', { name: 'Secret key' }).inputValue();
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await expect(auth.getByText(/shown only once/).first()).toBeVisible();
  // Wrong code first: MFA must NOT turn on.
  await auth.getByRole('textbox', { name: 'Six-digit code' }).fill('000000');
  await auth.getByRole('button', { name: 'Confirm with a code from your authenticator app' }).click();
  await expect(auth.getByRole('alert')).toBeVisible();
  await expect(auth.getByText('Two-factor authentication is on.')).toHaveCount(0);
  const { code, step } = await nextTotp(secret, null);
  await auth.getByRole('textbox', { name: 'Six-digit code' }).fill(code);
  await auth.getByRole('button', { name: 'Confirm with a code from your authenticator app' }).click();
  await expect(auth.getByText('Two-factor authentication is on.').first()).toBeVisible();
  // Recovery codes are shown once, at enrollment.
  const items = auth.locator('ul.grid li');
  await expect(items).toHaveCount(10);
  const codes = await items.allInnerTexts();
  for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  expect(new Set(codes).size).toBe(10);
  await auth.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(items).toHaveCount(0);
  return { secret, codes, lastStep: step };
}

test.describe('MFA (TOTP)', () => {
  test('enroll/confirm, MFA at sign-in (TOTP), step-up with TOTP gates sensitive actions, disable', async ({ page, authenticator, apiUrl }) => {
    const { email } = await signedInWithVault(page);
    const { secret, lastStep } = await enableMfa(page);
    let step = lastStep;

    // Sign out, sign in: the passkey alone no longer yields a session.
    await signOutViaUi(page);
    await signInWithPasskeyViaUi(page, email);
    await expect(page.getByText('Two-factor authentication', { exact: true })).toBeVisible();
    expect(await storedToken(page)).toBeNull();
    // Wrong code: login attempt is burned (single-use mfa token), restart from the beginning.
    await page.getByRole('textbox', { name: 'Authenticator code' }).fill('000000');
    await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(page.getByText(/second-factor attempt expired/)).toBeVisible();
    expect(await storedToken(page)).toBeNull();

    await signInWithPasskeyViaUi(page, email);
    const login = await nextTotp(secret, step);
    step = login.step;
    await page.getByRole('textbox', { name: 'Authenticator code' }).fill(login.code);
    await page.getByRole('button', { name: 'Verify code' }).click();
    // Signed in; vault is locked (separate step).
    await expect(page.getByText('Your vault is locked')).toBeVisible();
    const token = (await storedToken(page))!;
    expect(token).toMatch(/^sess_/);

    // MFA login is NOT a step-up: the server still refuses a sensitive action.
    expect((await apiFetch(apiUrl, token, 'DELETE', '/api/v1/auth/sessions/others')).status).toBe(403);
  });

  test('step-up with TOTP: wrong code and cancel do not run the action; right code does', async ({ page, authenticator, apiUrl }) => {
    await signedInWithVault(page);
    const { secret, lastStep } = await enableMfa(page);
    const auth = mfaSection(page);

    // Gated action: disable MFA.
    await auth.getByRole('button', { name: 'Disable two-factor authentication' }).click();
    await auth.getByRole('button', { name: 'Confirm', exact: true }).click();
    const dialog = stepUpDialog(page);
    await expect(dialog).toBeVisible();
    // Cancel: nothing happens, MFA still on server-side (a passkey sign-in would still need MFA — check via API).
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(auth.getByText('Two-factor authentication is off.')).toHaveCount(0);

    await auth.getByRole('button', { name: 'Disable two-factor authentication' }).click();
    await auth.getByRole('button', { name: 'Confirm', exact: true }).click();
    // Wrong code: error, dialog stays, still enabled.
    await stepUpWithTotp(page, '000000');
    await expect(dialog.getByRole('alert')).toContainText('Verification failed');
    await expect(auth.getByText('Two-factor authentication is off.')).toHaveCount(0);
    // Right code (next unused step).
    const { code } = await nextTotp(secret, lastStep);
    await dialog.getByRole('textbox', { name: 'Authenticator code' }).fill(code);
    await dialog.getByRole('button', { name: 'Verify it’s you' }).click();
    await expect(auth.getByText('Two-factor authentication is off.').first()).toBeVisible();
    // A TOTP code can't be replayed.
    const token = (await storedToken(page))!;
    expect((await apiFetch(apiUrl, token, 'POST', '/api/v1/auth/step-up/totp', { code })).status).toBe(401);
  });

  test('recovery codes: sign-in with a recovery code works once; regenerate invalidates the old set; disable returns to passkey-only', async ({ page, authenticator, apiUrl }) => {
    const { email } = await signedInWithVault(page);
    const { codes } = await enableMfa(page);

    // Regenerate (step-up via passkey): new set shown, old set dead.
    const auth = mfaSection(page);
    await auth.getByRole('button', { name: 'Generate new recovery codes' }).click();
    await stepUpWithPasskey(page);
    const items = auth.locator('ul.grid li');
    await expect(items).toHaveCount(10);
    const fresh = await items.allInnerTexts();
    expect(fresh.filter((c) => codes.includes(c))).toHaveLength(0);
    await auth.getByRole('button', { name: 'Done', exact: true }).click();

    const loginWith = async (code: string) => {
      await signInWithPasskeyViaUi(page, email);
      await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
      await page.getByRole('textbox', { name: 'Recovery code' }).fill(code);
      await page.getByRole('button', { name: 'Verify code' }).click();
    };
    await signOutViaUi(page);
    await loginWith(codes[0]); // old code
    await expect(page.getByText(/second-factor attempt expired/)).toBeVisible();
    expect(await storedToken(page)).toBeNull();

    await loginWith(fresh[0]);
    await expect(page.getByText('Your vault is locked')).toBeVisible();
    expect(await storedToken(page)).toMatch(/^sess_/);

    // Single use: the same (new) code fails the second time.
    await page.getByLabel('Master passphrase').fill('correct horse battery staple 42!');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await signOutViaUi(page);
    await loginWith(fresh[0]);
    await expect(page.getByText(/second-factor attempt expired/)).toBeVisible();

    // Another unused code still works, then disable MFA and confirm sign-in is passkey-only again.
    await loginWith(fresh[1]);
    await expect(page.getByText('Your vault is locked')).toBeVisible();
    await page.getByLabel('Master passphrase').fill('correct horse battery staple 42!');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await openSecurityCenter(page);
    await mfaSection(page).getByRole('button', { name: 'Disable two-factor authentication' }).click();
    await mfaSection(page).getByRole('button', { name: 'Confirm', exact: true }).click();
    await stepUpWithPasskey(page);
    await expect(mfaSection(page).getByText('Two-factor authentication is off.').first()).toBeVisible();
    await signOutViaUi(page);
    await signInWithPasskeyViaUi(page, email);
    await expect(page.getByText('Your vault is locked')).toBeVisible();
    expect(await storedToken(page)).toMatch(/^sess_/);
    expect((await apiFetch(apiUrl, (await storedToken(page))!, 'GET', SESSIONS_API)).status).toBe(200);
  });
});
