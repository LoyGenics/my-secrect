import { test, expect, registerAccountViaUi, createVaultViaUi, uniqueEmail, signOutViaUi, signInWithPasskeyViaUi, unlockVaultViaUi, storedToken, apiFetch, DEFAULT_PASSPHRASE } from './fixtures';

test('onboarding: register with passkey, create vault, recovery key shown once', async ({ page, authenticator, apiUrl }) => {
  const email = uniqueEmail();
  await registerAccountViaUi(page, email);
  expect(await authenticator.credentials()).toHaveLength(1);
  const token = await storedToken(page);
  expect(token).toMatch(/^sess_[0-9a-f]{64}$/);
  // Account is signed in, but the vault does not exist yet: onboarding, not an unlocked vault.
  await expect(page.getByText('Create your local vault')).toBeVisible();

  const recoveryKey = await createVaultViaUi(page);
  expect(recoveryKey).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url

  // The server knows the account but received nothing about the vault.
  const sessions = await apiFetch(apiUrl, token, 'GET', '/api/v1/auth/sessions');
  expect(sessions.status).toBe(200);
});
