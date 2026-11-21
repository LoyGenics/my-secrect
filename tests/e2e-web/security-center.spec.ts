import {
  newVirtualAuthenticator, createVaultViaUi, openSecurityCenter, openSecurityCenterTab,
  test, expect, signedInWithVault, storedToken, apiFetch, secondBrowser, stepUpWithPasskey,
  signInWithPasskeyViaUi, syncCredentials, unlockVaultViaUi, SESSIONS_API, stepUpDialog,
} from './fixtures';

async function openSecurityCenterNoWait(page: import('@playwright/test').Page) {
  await openSecurityCenterTab(page);
}

const section = (page: import('@playwright/test').Page, heading: string) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: heading, exact: true }) });

test.describe('Security Center: passkeys', () => {
  test('list, add (server step-up with passkey), remove, and the last-passkey guard', async ({ page, authenticator, apiUrl }) => {
    await signedInWithVault(page);
    const auth = section(page, 'Authentication methods');
    await expect(auth.getByText(/^[\w-]{12}…$/)).toHaveCount(1);

    // Server step-up is required to add a passkey: the dialog offers NO passphrase option.
    await auth.getByRole('button', { name: 'Add passkey' }).click();
    const dialog = stepUpDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'Master passphrase' })).toHaveCount(0);
    await expect(dialog.getByText(/never sent to the server/)).toBeVisible();
    // Cancelling must not add anything.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(await authenticator.credentials()).toHaveLength(1);
    expect((await apiFetch(apiUrl, await storedToken(page), 'GET', '/api/v1/auth/passkeys')).json.passkeys).toHaveLength(1);

    // A second passkey must come from a DIFFERENT authenticator: the server sends
    // excludeCredentials, so an authenticator already holding this account's
    // passkey is (correctly) refused. The step-up assertion needs the FIRST
    // authenticator, so the swap happens only once the server has issued the
    // (post-step-up) creation options; the first passkey is restored afterwards.
    let saved: any[] = [];
    let second: Awaited<ReturnType<typeof newVirtualAuthenticator>> | null = null;
    await page.route('**/v1/auth/passkeys/add/options', async (route) => {
      const res = await route.fetch();
      if (res.status() === 200) {
        saved = await authenticator.exportCredentials();
        await authenticator.remove();
        second = await newVirtualAuthenticator(page);
      }
      await route.fulfill({ response: res });
    });
    await auth.getByRole('button', { name: 'Add passkey' }).click();
    await stepUpWithPasskey(page);
    await expect(auth.getByText('Passkey added.')).toBeVisible();
    expect(await second!.credentials()).toHaveLength(1);
    await second!.importCredentials(saved);
    await page.unroute('**/v1/auth/passkeys/add/options');
    // The rotated session token was adopted: the page keeps working.
    expect((await apiFetch(apiUrl, await storedToken(page), 'GET', SESSIONS_API)).status).toBe(200);

    // Remove one (step-up still fresh within 10 minutes).
    await auth.getByRole('button', { name: 'Remove passkey' }).first().click();
    await auth.getByRole('button', { name: 'Confirm' }).click();
    await expect(auth.getByText('Passkey removed.')).toBeVisible();
    await expect(auth.getByText(/^[\w-]{12}…$/)).toHaveCount(1);

    // Last-passkey guard: the server refuses (MFA is off) and the UI explains why.
    await auth.getByRole('button', { name: 'Remove passkey' }).click();
    await auth.getByRole('button', { name: 'Confirm' }).click();
    await expect(auth.getByRole('alert').filter({ hasText: 'only passkey' })).toBeVisible();
    await expect(auth.getByText(/^[\w-]{12}…$/)).toHaveCount(1);
    const list = await apiFetch(apiUrl, await storedToken(page), 'GET', '/api/v1/auth/passkeys');
    expect(list.json.passkeys.filter((p: any) => !p.revoked_at)).toHaveLength(1);
  });
});

test.describe('Security Center: sessions', () => {
  test('list, revoke one session, revoke all others; copy never promises deletion of offline data', async ({ page, authenticator, apiUrl, browser }) => {
    await signedInWithVault(page);
    const sessionsSection = section(page, 'Sessions');
    // Honest-copy requirement: always visible next to the revoke controls.
    await expect(sessionsSection.getByText(/does NOT erase secrets already downloaded or stored offline/).first()).toBeVisible();
    await expect(sessionsSection.getByText('Current session')).toHaveCount(1);

    // A second browser signs in with the same passkey => a second server session.
    const other = await secondBrowser(browser, apiUrl, authenticator);
    const email = (await page.evaluate(() => localStorage.getItem('my-secrect:account-email')))!;
    await other.page.goto('/');
    await signInWithPasskeyViaUi(other.page, email);
    await expect(other.page.getByText('Create your local vault')).toBeVisible();
    await syncCredentials(other.authenticator, authenticator);
    await createVaultViaUi(other.page);
    await openSecurityCenter(other.page);
    const otherToken = (await storedToken(other.page))!;
    expect((await apiFetch(apiUrl, otherToken, 'GET', SESSIONS_API)).status).toBe(200);

    // Reload Security Center: two sessions, one current.
    await page.reload();
    await unlockVaultViaUi(page);
    await openSecurityCenterTab(page);
    await expect(sessionsSection.getByRole('button', { name: 'Revoke session' })).toHaveCount(1);

    // Revoke the other one.
    await sessionsSection.getByRole('button', { name: 'Revoke session' }).click();
    await sessionsSection.getByRole('button', { name: 'Confirm' }).click();
    await expect(sessionsSection.getByRole('status').filter({ hasText: 'does NOT erase data' })).toBeVisible();
    await expect(sessionsSection.getByRole('button', { name: 'Revoke session' })).toHaveCount(0);
    expect((await apiFetch(apiUrl, otherToken, 'GET', SESSIONS_API)).status).toBe(401);
    // The revoked browser only learns on its next server call, then is sent back to sign-in.
    await other.page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Vault' }).click();
    await openSecurityCenterNoWait(other.page);
    await expect(other.page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
    await expect(other.page.getByText('Your session expired')).toBeVisible();
    expect(await storedToken(other.page)).toBeNull();

    // Revoke ALL others (needs server step-up): sign in again from the other browser first.
    await signInWithPasskeyViaUi(other.page, email);
    // The session expiring never locked that browser's (in-memory) vault: separate concerns.
    await expect(other.page.getByRole('button', { name: /Lock vault/ })).toBeVisible();
    await syncCredentials(other.authenticator, authenticator);
    const otherToken2 = (await storedToken(other.page))!;
    await page.reload();
    await unlockVaultViaUi(page);
    await openSecurityCenterTab(page);
    // Before step-up the server refuses (independent of the UI).
    const mine = (await storedToken(page))!;
    expect((await apiFetch(apiUrl, mine, 'DELETE', '/api/v1/auth/sessions/others')).status).toBe(403);
    await sessionsSection.getByRole('button', { name: 'Revoke all other sessions' }).click();
    await sessionsSection.getByRole('button', { name: 'Confirm' }).click();
    await stepUpWithPasskey(page);
    await expect(sessionsSection.getByRole('status').filter({ hasText: 'Other sessions revoked: 1' })).toBeVisible();
    expect((await apiFetch(apiUrl, otherToken2, 'GET', SESSIONS_API)).status).toBe(401);
    expect((await apiFetch(apiUrl, (await storedToken(page))!, 'GET', SESSIONS_API)).status).toBe(200);
    await other.context.close();
  });
});

test.describe('Security Center: trusted devices', () => {
  test('list, enroll (step-up), trust, rename, revoke; revoke copy is honest', async ({ page, authenticator, apiUrl }) => {
    await signedInWithVault(page);
    const devices = section(page, 'Trusted devices');
    await expect(devices.getByText(/Revoking a device ends its server sessions\. It does NOT erase secrets already downloaded or stored offline/)).toBeVisible();
    // Registration enrolled the first device automatically (device proof at sign-up).
    await expect(devices.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(1);
    const signUpDevices = (await apiFetch(apiUrl, await storedToken(page), 'GET', '/api/v1/devices')).json.devices;
    expect(signUpDevices).toHaveLength(1);

    // Enroll this browser (server step-up: passkey, plus proof of possession).
    await devices.getByLabel('Device name').fill('E2E laptop');
    await devices.getByRole('button', { name: 'Enroll this browser as a device' }).click();
    await stepUpWithPasskey(page);
    await expect(devices.getByText('Device enrolled.')).toBeVisible();
    await expect(devices.getByText('E2E laptop')).toBeVisible();
    await expect(devices.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(2);
    // Server stores only ciphertext of the name + the public key; no plaintext name on the wire.
    const token = (await storedToken(page))!;
    const raw = await apiFetch(apiUrl, token, 'GET', '/api/v1/devices');
    // The sign-up device also has a platform now, so pick the NEW row.
    const enrolled = raw.json.devices.find((d: any) => d.id !== signUpDevices[0].id);
    expect(enrolled).toBeTruthy();
    expect(enrolled.platform).toBeTruthy();
    expect(JSON.stringify(raw.json)).not.toContain('E2E laptop');

    // Trust, then untrust.
    const row = devices.locator('li').filter({ hasText: 'E2E laptop' });
    await expect(row.getByText('Not trusted')).toBeVisible();
    await row.getByRole('button', { name: 'Trust', exact: true }).click();
    await expect(row.getByText(/^Trusted/)).toBeVisible();
    await row.getByRole('button', { name: 'Remove trust' }).click();
    await expect(row.getByText(/^Not trusted/)).toBeVisible();

    // Rename (encrypted under the vault key).
    await row.getByRole('button', { name: 'Rename' }).click();
    await row.getByRole('textbox', { name: 'Rename' }).fill('Renamed box');
    await row.getByRole('button', { name: 'Save' }).click();
    await expect(devices.getByText('Renamed box')).toBeVisible();

    // Revoke the enrolled device: it disappears and the server marks it revoked.
    const renamed = devices.locator('li').filter({ hasText: 'Renamed box' });
    await renamed.getByRole('button', { name: 'Revoke', exact: true }).click();
    // Confirmation states what revocation cannot do, and offers the passkey.
    const confirm = renamed.getByRole('group', { name: 'Revoke this device?' });
    await expect(confirm.getByText(/cannot erase what is already on the device/)).toBeVisible();
    await expect(confirm.getByText(/Rotating the vault key would protect items you create from now on — that is not available yet/)).toBeVisible();
    await expect(confirm.getByLabel('Also revoke the passkey that signed in this device')).not.toBeChecked();
    await confirm.getByRole('button', { name: 'Revoke device' }).click();
    await expect(devices.getByText('Device revoked: its server sessions were ended.')).toBeVisible();
    await expect(devices.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(1);
    const after = await apiFetch(apiUrl, token, 'GET', '/api/v1/devices');
    expect(after.json.devices.find((d: any) => d.id === enrolled.id).revoked_at).toBeTruthy();
  });

  test('revoking the device that owns the current session ends it; the app returns to sign-in', async ({ page, authenticator, apiUrl }) => {
    await signedInWithVault(page);
    const devices = section(page, 'Trusted devices');
    const token = (await storedToken(page))!;
    await devices.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(devices.getByText('This is the device you are using now: you will be signed out.')).toBeVisible();
    await devices.getByRole('button', { name: 'Revoke device' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
    expect((await apiFetch(apiUrl, token, 'GET', SESSIONS_API)).status).toBe(401);
  });
});

test.describe('Security Center: account deletion', () => {
  test('requires step-up, deletes the server account, clears the session, and is honest about the local vault', async ({ page, authenticator, apiUrl }) => {
    await signedInWithVault(page);
    const token = (await storedToken(page))!;
    const del = section(page, 'Delete account');
    await expect(del.getByText(/The vault stored on this device is not erased/)).toBeVisible();

    // Server refuses without step-up, independent of the UI.
    expect((await apiFetch(apiUrl, token, 'DELETE', '/api/v1/auth/account')).status).toBe(403);

    // Cancelling the step-up must not delete anything.
    await del.getByRole('button', { name: 'Delete account', exact: true }).click();
    await del.getByRole('button', { name: 'Confirm', exact: true }).click();
    await stepUpDialog(page).getByRole('button', { name: 'Cancel' }).click();
    expect((await apiFetch(apiUrl, token, 'GET', SESSIONS_API)).status).toBe(200);

    // Real deletion.
    await del.getByRole('button', { name: 'Delete account', exact: true }).click();
    await del.getByRole('button', { name: 'Confirm', exact: true }).click();
    await stepUpWithPasskey(page);
    await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
    expect(await storedToken(page)).toBeNull();
    expect((await apiFetch(apiUrl, token, 'GET', SESSIONS_API)).status).toBe(401);

  });
});
