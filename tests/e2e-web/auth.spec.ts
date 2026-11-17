import {
  test, expect, registerAccountViaUi, createVaultViaUi, uniqueEmail, signOutViaUi,
  signInWithPasskeyViaUi, unlockVaultViaUi, storedToken, apiFetch, DEFAULT_PASSPHRASE,
} from './fixtures';

test.describe('sign out / sign in / vault unlock are separate', () => {
  test('sign out revokes the server session; passkey sign-in works; sign-in does not unlock the vault', async ({ page, authenticator, apiUrl }) => {
    const email = uniqueEmail();
    await registerAccountViaUi(page, email);
    await createVaultViaUi(page);
    const token1 = await storedToken(page);
    expect(token1).not.toBeNull();
    expect((await apiFetch(apiUrl, token1, 'GET', '/api/v1/auth/sessions')).status).toBe(200);

    await signOutViaUi(page);
    expect(await storedToken(page)).toBeNull();
    // The server really ended that session (not just a local token delete).
    expect((await apiFetch(apiUrl, token1, 'GET', '/api/v1/auth/sessions')).status).toBe(401);

    // Real passkey assertion against the real server.
    const before = (await authenticator.credentials())[0].signCount;
    await signInWithPasskeyViaUi(page, email);
    // Signed in, but the vault is locked: lock screen, not the vault shell.
    await expect(page.getByText('Your vault is locked')).toBeVisible();
    await expect(page.getByRole('button', { name: /Lock vault/ })).toHaveCount(0);
    const token2 = await storedToken(page);
    expect(token2).toMatch(/^sess_[0-9a-f]{64}$/);
    expect(token2).not.toBe(token1);
    expect((await authenticator.credentials())[0].signCount).toBeGreaterThan(before);
    expect((await apiFetch(apiUrl, token2, 'GET', '/api/v1/auth/sessions')).status).toBe(200);

    // Unlock is a separate local step: wrong passphrase fails, account session unaffected.
    await unlockVaultViaUi(page, 'definitely the wrong passphrase');
    await expect(page.locator('p.text-red-400')).toBeVisible();
    await expect(page.getByText('Your vault is locked')).toBeVisible();
    expect((await apiFetch(apiUrl, token2, 'GET', '/api/v1/auth/sessions')).status).toBe(200);

    await unlockVaultViaUi(page, DEFAULT_PASSPHRASE);
    await expect(page.getByRole('button', { name: /Lock vault/ })).toBeVisible();
  });

  test('vault lock does not sign out; vault unlock needs the passphrase even with a valid session', async ({ page, authenticator }) => {
    await registerAccountViaUi(page, uniqueEmail());
    await createVaultViaUi(page);
    await page.getByRole('button', { name: /Lock vault/ }).click();
    await expect(page.getByText('Your vault is locked')).toBeVisible();
    await page.reload();
    // Reload keeps the account session but never the unlocked vault.
    await expect(page.getByText('Your vault is locked')).toBeVisible();
    expect(await storedToken(page)).not.toBeNull();
  });

  test('sign-in with an unknown email fails generically', async ({ page, authenticator }) => {
    await page.goto('/');
    await signInWithPasskeyViaUi(page, uniqueEmail('nobody'));
    await expect(page.getByText(/Sign-in failed|Passkeys are not available|cancelled/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
    expect(await storedToken(page)).toBeNull();
  });

  test('passkey sign-in fails when the authenticator no longer has the credential', async ({ page, authenticator }) => {
    const email = uniqueEmail();
    await registerAccountViaUi(page, email);
    await createVaultViaUi(page);
    await signOutViaUi(page);
    await authenticator.clearCredentials();
    await signInWithPasskeyViaUi(page, email);
    // The ceremony cannot produce an assertion; the app must stay on the gate and say so.
    await expect(page.getByText(/Sign-in failed|cancelled/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
    expect(await storedToken(page)).toBeNull();
  });
});
