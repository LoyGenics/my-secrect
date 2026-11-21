/**
 * Real-Chromium e2e for the account sign-in gate, against the mock account
 * API in fixtures.ts (which verifies the Ed25519 device proof for real).
 * Serial: one persistent context, one account, one vault.
 * Run: npm --workspace apps/extension run test:e2e
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildExtension, EMAIL_CODE, MFA_CODE, signInViaMessages, startMockApi, type MockApi } from './fixtures';

// Test fixtures only (not real secrets).
const PASSPHRASE = 'account-Passphrase-Not-A-Real-Secret-3';

let mockApi: MockApi;
let ctx: BrowserContext;
let extId = '';
let admin: Page;
let recoveryKey = '';

type Reply = Record<string, unknown>;
const bg = (msg: Reply) => admin.evaluate((m) => chrome.runtime.sendMessage(m) as Promise<Reply>, msg);
const step = async () => ((await bg({ type: 'getAccount' })).account as { step: string }).step;
const SIGNED_OUT = { ok: false, authError: 'signed-out' };

test.describe.serial('account sign-in gate in real Chromium', () => {
  test.beforeAll(async () => {
    const dist = buildExtension();
    mockApi = await startMockApi();
    ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'my-secrect-account-')), {
      channel: 'chromium',
      headless: process.env.E2E_HEADED !== '1',
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    });
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
    extId = new URL(sw.url()).host;
    admin = await ctx.newPage();
    await admin.goto(`chrome-extension://${extId}/options/index.html`);
  });

  test.afterAll(async () => {
    await ctx?.close();
    await mockApi?.close();
  });

  test('no server configured: signed out, every vault entry point refused, the popup offers no way around', async () => {
    expect((await bg({ type: 'getAccount' })).account).toEqual({
      step: 'signed-out', email: null, serverConfigured: false, apiBaseUrl: '', apiBaseUrlOverride: '',
    });
    expect(await bg({ type: 'requestEmailCode', email: 'a@example.test' })).toMatchObject({ ok: false, authError: 'server-not-configured' });
    for (const msg of [
      { type: 'createVault', passphrase: PASSPHRASE },
      { type: 'unlock', passphrase: PASSPHRASE },
      { type: 'unlockRecovery', recoveryKey: 'x' },
      { type: 'restoreBackup', json: '{}', passphrase: 'x' },
    ]) expect(await bg(msg)).toMatchObject(SIGNED_OUT);
    expect((await bg({ type: 'getStatus' })).status).toEqual({ locked: true, vaultExists: false });

    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/index.html`);
    await expect(popup.getByRole('heading', { name: 'Sign in to My Secret' })).toBeVisible();
    await expect(popup.getByText('No account server is set.')).toBeVisible();
    await expect(popup.locator('#new-pass, #master-passphrase, #signin-email')).toHaveCount(0);
    await popup.close();
    // Options: restore asks for sign-in instead of showing the form.
    await admin.reload();
    await expect(admin.getByTestId('restore-needs-signin')).toBeVisible();
    await expect(admin.locator('#restore-file')).toHaveCount(0);
  });

  test('server address: https or local http only; a bad one changes nothing', async () => {
    for (const url of ['http://vault.example.test/api', 'https://u:p@vault.example.test/api', 'javascript:alert(1)']) {
      expect(await bg({ type: 'setApiBaseUrl', url })).toMatchObject({ ok: false, authError: 'invalid-server-url' });
    }
    expect(await bg({ type: 'setApiBaseUrl', url: `${mockApi.base}/` })).toMatchObject({
      ok: true, account: { step: 'signed-out', serverConfigured: true, apiBaseUrl: mockApi.base, apiBaseUrlOverride: mockApi.base },
    });
  });

  test('Google button only when the server offers a Google client for the extension', async () => {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/index.html`);
    await expect(popup.locator('#signin-email')).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
    await expect(popup.getByRole('button', { name: /Apple/ })).toHaveCount(0);
    mockApi.google = true;
    await popup.reload();
    await expect(popup.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    await expect(popup.getByRole('button', { name: /Apple/ })).toHaveCount(0); // never in the extension (README)
    expect(await bg({ type: 'getAuthProviders' })).toEqual({ ok: true, providers: { google: true } });
    mockApi.google = false;
    await popup.close();
  });

  test('MFA account: email code, then the authenticator code; a wrong MFA code restarts from the email', async () => {
    expect(await bg({ type: 'requestEmailCode', email: 'mfa@example.test' })).toMatchObject({ ok: true, account: { step: 'email-code', email: 'mfa@example.test' } });
    expect(await bg({ type: 'verifyEmailCode', code: '999999' })).toMatchObject({ ok: false, authError: 'code-failed' });
    expect(await step()).toBe('email-code'); // the code allows another try
    expect(await bg({ type: 'verifyEmailCode', code: EMAIL_CODE })).toMatchObject({ ok: true, account: { step: 'mfa' } });
    // The single-use MFA token never reaches the page.
    expect(JSON.stringify(await bg({ type: 'getAccount' }))).not.toMatch(/mfa_?token/i);
    expect(await bg({ type: 'verifyMfa', code: '000000' })).toMatchObject({ ok: false, authError: 'mfa-failed' });
    expect(await step()).toBe('signed-out');
    expect(await bg({ type: 'createVault', passphrase: PASSPHRASE })).toMatchObject(SIGNED_OUT);

    // Through the popup this time, to the end.
    await bg({ type: 'requestEmailCode', email: 'mfa@example.test' });
    await bg({ type: 'verifyEmailCode', code: EMAIL_CODE });
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/index.html`);
    await expect(popup.getByTestId('signin-mfa')).toBeVisible();
    await popup.fill('#signin-code', MFA_CODE);
    await popup.getByRole('button', { name: 'Verify', exact: true }).click();
    await expect(popup.getByRole('heading', { name: 'Create your vault' })).toBeVisible();
    await popup.close();
    expect((await bg({ type: 'getAccount' })).account).toMatchObject({ step: 'signed-in', email: 'mfa@example.test' });
  });

  test('signed in: the popup/options never receive the session token; the vault can now be created', async () => {
    const [token] = [...mockApi.sessions.keys()];
    expect(token).toMatch(/^sess_/);
    expect(JSON.stringify(await bg({ type: 'getAccount' }))).not.toContain(token);
    expect(JSON.stringify(await admin.evaluate(() => chrome.storage.local.get(null)))).not.toContain(token);
    const created = await bg({ type: 'createVault', passphrase: PASSPHRASE });
    recoveryKey = String(created.recoveryKey);
    expect(recoveryKey.length).toBeGreaterThan(40);
    // Nothing about the vault ever went to the account server.
    const sent = JSON.stringify(mockApi.requests);
    for (const secret of [PASSPHRASE, recoveryKey]) expect(sent).not.toContain(secret);
    expect(new Set(mockApi.requests.map((r) => r.path))).toEqual(new Set([
      '/v1/auth/providers', '/v1/auth/email/request', '/v1/auth/email/verify', '/v1/auth/email/session', '/v1/auth/mfa/verify', '/v1/auth/sessions',
    ]));
  });

  test('a 401 from the server means signed out: unlock is refused until signing in again', async () => {
    await bg({ type: 'lock' });
    mockApi.expireAll(); // revoked or expired server-side
    expect(await step()).toBe('signed-out');
    expect(await bg({ type: 'unlock', passphrase: PASSPHRASE })).toMatchObject(SIGNED_OUT);
    expect(await bg({ type: 'unlockRecovery', recoveryKey })).toMatchObject(SIGNED_OUT);
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/index.html`);
    await expect(popup.getByRole('heading', { name: 'Sign in to My Secret' })).toBeVisible();
    await popup.close();
    await signInViaMessages(bg, mockApi.base, 'second@example.test');
    expect(await bg({ type: 'unlock', passphrase: PASSPHRASE })).toMatchObject({ ok: true, unlocked: true });
  });

  test('sign out from the popup locks the vault and revokes the server session', async () => {
    const [live] = [...mockApi.sessions.values()];
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/index.html`);
    await expect(popup.getByRole('button', { name: 'Lock', exact: true })).toBeVisible();
    await popup.getByRole('button', { name: 'Settings' }).click();
    await popup.getByRole('button', { name: 'Sign out' }).click();
    await expect(popup.getByRole('heading', { name: 'Sign in to My Secret' })).toBeVisible();
    await popup.close();
    expect(mockApi.revoked).toContain(live.id);
    expect(mockApi.sessions.size).toBe(0);
    expect((await bg({ type: 'getStatus' })).status).toEqual({ locked: true, vaultExists: true });
    expect(await admin.evaluate(() => chrome.storage.session.get(null))).toEqual({});
    expect(await bg({ type: 'unlock', passphrase: PASSPHRASE })).toMatchObject(SIGNED_OUT);
  });

  test('changing the account server signs out and locks', async () => {
    await signInViaMessages(bg, mockApi.base);
    expect(await bg({ type: 'unlock', passphrase: PASSPHRASE })).toMatchObject({ ok: true, unlocked: true });
    expect(await bg({ type: 'setApiBaseUrl', url: 'https://other-server.example.test/api' })).toMatchObject({ ok: true, account: { step: 'signed-out' } });
    expect((await bg({ type: 'getStatus' })).status).toEqual({ locked: true, vaultExists: true });
    expect(await bg({ type: 'unlock', passphrase: PASSPHRASE })).toMatchObject(SIGNED_OUT);
    expect(mockApi.sessions.size).toBe(0);
  });
});
