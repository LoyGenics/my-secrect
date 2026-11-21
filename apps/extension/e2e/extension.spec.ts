/**
 * Real-Chromium e2e for the MV3 extension. Serial: one persistent context,
 * one vault created through the real popup UI.
 * Run: npm --workspace apps/extension run test:e2e
 */
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildExtension, EMAIL_CODE, referenceTotp, startMockApi, startServers, type MockApi, type Servers } from './fixtures';

// Test fixtures only (not real secrets).
const PASSPHRASE = 'e2e-Passphrase-Not-A-Real-Secret-1';
const PW_A = 'pw-A-fixture-9Zk2';
const PW_BANK = 'pw-bank-fixture-4Qm7';
const PW_PUNY = 'pw-puny-fixture-1Xv5';
const PW_LOCAL = 'pw-local-fixture-8Lc3';
const PW_TOTP = 'pw-totp-fixture-6Hd1';
// RFC 6238 Appendix B SHA-1 seed "12345678901234567890", base32-encoded.
const RFC_SECRET_ASCII = '12345678901234567890';
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

let servers: Servers;
let mockApi: MockApi;
let ctx: BrowserContext;
let sw: Worker;
let extId: string;
let admin: Page; // extension page used only to send messages to the background
let web: Page; // the "website" tab
let recoveryKey = '';
const ids: Record<string, string> = {};

type Msg = Record<string, unknown>;
const bg = (msg: Msg) =>
  admin.evaluate((m) => chrome.runtime.sendMessage(m) as Promise<Record<string, unknown>>, msg);

const https = (host: string) => `https://${host}:${servers.httpsPort}/login`;

async function openSite(url: string): Promise<void> {
  await web.goto(url);
  await web.bringToFront();
  // Sanity: the worker sees THIS tab as the active one.
  const seen = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.url);
  expect(seen).toBe(url);
}

async function fillAttempt(id: string, confirmed = false) {
  return bg({ type: 'fill', id, confirmed });
}

const values = async () => ({
  user: await web.inputValue('#user'),
  pass: await web.inputValue('#pass'),
});
const contentInjected = () => web.evaluate(() => (window as unknown as { __mySecrectContentLoaded?: boolean }).__mySecrectContentLoaded === true);

function loginItem(title: string, fields: Record<string, unknown>, type = 'login') {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), type, schema_version: 1, title, fields,
    tags: [], relations: [], attachments: [], created_at: now, updated_at: now,
  };
}

test.describe.serial('MV3 extension in real Chromium', () => {
  test.beforeAll(async () => {
    const dist = buildExtension();
    servers = await startServers();
    mockApi = await startMockApi();
    ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'my-secrect-profile-')), {
      channel: 'chromium', // full Chromium (new headless), required for extensions
      headless: process.env.E2E_HEADED !== '1',
      args: [
        `--disable-extensions-except=${dist}`,
        `--load-extension=${dist}`,
        '--host-resolver-rules=MAP *.test 127.0.0.1',
        '--ignore-certificate-errors', // local self-signed cert for the https test origins
      ],
    });
    sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
    extId = new URL(sw.url()).host;
    admin = await ctx.newPage();
    await admin.goto(`chrome-extension://${extId}/options/index.html`);
    web = await ctx.newPage();
  });

  test.afterAll(async () => {
    await ctx?.close();
    await servers?.close();
    await mockApi?.close();
  });

  test('account sign-in through the real popup UI comes before the vault', async () => {
    // Options page: point the extension at the (mock) account server.
    await admin.fill('#api-base-url', mockApi.base);
    await admin.getByRole('button', { name: 'Save address' }).click();
    await expect(admin.getByRole('status')).toHaveText('Account server saved.');
    // Signed out: no vault can be created, the popup opens on sign-in.
    expect(await bg({ type: 'createVault', passphrase: PASSPHRASE })).toMatchObject({ ok: false, authError: 'signed-out' });
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/index.html`);
    await expect(popup.getByRole('heading', { name: 'Sign in to My Secret' })).toBeVisible();
    await expect(popup.locator('#new-pass')).toHaveCount(0);
    await expect(popup.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0); // server offers no Google
    await popup.fill('#signin-email', 'e2e@example.test');
    await popup.getByRole('button', { name: 'Email me a code' }).click();
    await expect(popup.getByText('We sent a 6-digit code to e2e@example.test.')).toBeVisible();
    await popup.fill('#signin-code', '000000');
    await popup.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(popup.getByRole('alert')).toHaveText('That code did not work. Check it and try again.');
    await popup.fill('#signin-code', EMAIL_CODE);
    await popup.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(popup.getByRole('heading', { name: 'Create your vault' })).toBeVisible();
    // The device proof was checked by the mock server; the session is bound to it.
    expect([...mockApi.sessions.values()]).toEqual([expect.objectContaining({ email: 'e2e@example.test', deviceId: expect.stringMatching(/^dev-/) })]);
    await popup.close();
  });

  test('onboarding through the real popup UI creates a vault and shows a recovery key', async () => {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/index.html`);
    // No sync yet: onboarding and the empty-profile restore section say restore-from-backup is the way in.
    await expect(popup.getByText('Sync is not available in the extension yet')).toBeVisible();
    await expect(admin.getByTestId('restore-sync-note')).toContainText('export an encrypted backup in the desktop app');
    await popup.fill('#new-pass', PASSPHRASE);
    await popup.fill('#new-pass-confirm', PASSPHRASE);
    await popup.getByRole('button', { name: 'Create vault' }).click();
    const keyBox = popup.getByTestId('recovery-key');
    await expect(keyBox).toBeVisible({ timeout: 60_000 });
    recoveryKey = (await keyBox.innerText()).replace(/\s+/g, ''); // shown in groups of 4
    expect(recoveryKey.length).toBeGreaterThanOrEqual(40);
    // Regression: with a CSP that blocked wasm, libsodium's randombytes returned
    // WASM heap contents (the key embedded the passphrase). Key must be 32 bytes
    // and contain no passphrase bytes.
    const keyBytes = Buffer.from(recoveryKey, 'base64url');
    expect(keyBytes.length).toBe(32);
    expect(keyBytes.toString('latin1')).not.toContain(PASSPHRASE.slice(0, 8));
    await popup.check('#recovery-ack');
    await popup.getByRole('button', { name: 'Done' }).click();
    await popup.getByRole('button', { name: 'Open vault' }).click();
    await expect(popup.getByRole('button', { name: 'Lock', exact: true })).toBeVisible();
    // Vault key/plaintext must not be in chrome.storage.local (ciphertext rows only).
    const raw = JSON.stringify(await admin.evaluate(() => chrome.storage.local.get(null)));
    expect(raw).not.toContain(PASSPHRASE);
    expect(raw).not.toContain(recoveryKey);
    await popup.close();
  });

  test('add logins (popup UI for one, saveLogin message for the rest)', async () => {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Add a login' }).click();
    await popup.fill('#add-title', 'Example');
    await popup.fill('#add-username', 'alice');
    await popup.fill('#add-password', PW_A);
    await popup.fill('#add-url', `https://example.test:${servers.httpsPort}/login`);
    await popup.getByRole('button', { name: 'Save login' }).click();
    await expect(popup.getByRole('status')).toHaveText('Login saved.');
    await popup.close();

    const all = (await bg({ type: 'listAll' })).items as { id: string; title: string }[];
    ids.A = all.find((i) => i.title === 'Example')!.id;
    for (const [key, item] of Object.entries({
      TOTP: loginItem('TOTP site', { username: 'bob', password: PW_TOTP, url: `https://totp.test:${servers.httpsPort}/`, totp_secret: RFC_SECRET_B32 }),
      BANK: loginItem('Bank', { username: 'carol', password: PW_BANK, url: `https://bank.test:${servers.httpsPort}/` }, 'bank_account'),
      PUNY: loginItem('Puny', { username: 'dave', password: PW_PUNY, url: `https://xn--80ak6aa92e.test:${servers.httpsPort}/` }),
      LOCAL: loginItem('Local dev', { username: 'erin', password: PW_LOCAL, url: `http://localhost:${servers.httpPort}/` }),
    })) {
      expect((await bg({ type: 'saveLogin', item })).ok).toBe(true);
      ids[key] = item.id;
    }
    expect(((await bg({ type: 'listAll' })).items as unknown[]).length).toBe(5);
  });

  test('listLogins matches exact/subdomain and rejects lookalikes', async () => {
    const titles = async (host: string) =>
      ((await bg({ type: 'listLogins', origin: `https://${host}` })).logins as { title: string }[]).map((l) => l.title);
    expect(await titles('example.test')).toEqual(['Example']);
    expect(await titles('login.example.test')).toEqual(['Example']);
    expect(await titles('example.test.evil.test')).toEqual([]);
    expect(await titles('evilexample.test')).toEqual([]);
    expect(await titles('example.test-evil.test')).toEqual([]);
    expect(await titles('xn--exmple-cua.test')).toEqual([]);
  });

  for (const host of ['example.test', 'login.example.test']) {
    test(`autofills the matching https login form on ${host}`, async () => {
      await openSite(https(host));
      expect(await values()).toEqual({ user: '', pass: '' });
      const res = await fillAttempt(ids.A);
      expect(res).toEqual({ ok: true, filled: true });
      expect(await values()).toEqual({ user: 'alice', pass: PW_A });
    });
  }

  const refusals: [string, string][] = [
    ['subdomain-suffix trick example.test.evil.test', 'example.test.evil.test'],
    ['suffix without dot evilexample.test', 'evilexample.test'],
    ['hyphen lookalike example.test-evil.test', 'example.test-evil.test'],
    ['punycode homograph xn--exmple-cua.test', 'xn--exmple-cua.test'],
    ['unrelated host other.test', 'other.test'],
  ];
  for (const [name, url] of refusals) {
    test(`refuses to fill on ${name}`, async () => {
      await openSite(https(url));
      const res = await fillAttempt(ids.A);
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain('This login is for example.test');
      expect(await values()).toEqual({ user: '', pass: '' });
      expect(await contentInjected()).toBe(false); // script never even injected
    });
  }

  test('refuses plain http for a remote host (http vs https mismatch)', async () => {
    await openSite(`http://example.test:${servers.httpPort}/login`);
    const res = await fillAttempt(ids.A);
    expect(res).toMatchObject({ ok: false, error: 'Refusing to fill on a non-HTTPS page.' });
    expect(await values()).toEqual({ user: '', pass: '' });
    expect(await contentInjected()).toBe(false);
  });

  test('http://localhost dev exception fills only its own item; raw IP refused', async () => {
    await openSite(`http://localhost:${servers.httpPort}/login`);
    expect((await fillAttempt(ids.A)).ok).toBe(false); // example.test item must not fill on localhost
    expect(await values()).toEqual({ user: '', pass: '' });
    expect(await fillAttempt(ids.LOCAL)).toEqual({ ok: true, filled: true });
    expect(await values()).toEqual({ user: 'erin', pass: PW_LOCAL });

    await openSite(`http://127.0.0.1:${servers.httpPort}/login`);
    const res = await fillAttempt(ids.LOCAL);
    expect(res).toMatchObject({ ok: false, error: 'Refusing to fill on a raw IP address.' });
    expect(await values()).toEqual({ user: '', pass: '' });
  });

  test('punycode and bank items need explicit confirmation before filling', async () => {
    await openSite(https('xn--80ak6aa92e.test'));
    const first = await fillAttempt(ids.PUNY);
    expect(first.ok).toBe(false);
    expect(first.needsConfirmation).toBeTruthy();
    expect(await values()).toEqual({ user: '', pass: '' });
    expect(await fillAttempt(ids.PUNY, true)).toEqual({ ok: true, filled: true });
    expect(await values()).toEqual({ user: 'dave', pass: PW_PUNY });

    await openSite(https('bank.test'));
    const bank = await fillAttempt(ids.BANK);
    expect(bank.ok).toBe(false);
    expect(bank.needsConfirmation).toBeTruthy();
    expect((await values()).pass).toBe('');
    expect((await fillAttempt(ids.BANK, true)).ok).toBe(true);
    expect((await values()).pass).toBe(PW_BANK);
  });

  test('blocked origin in settings wins over a matching domain', async () => {
    const settings = (await bg({ type: 'getSettings' })).settings as Record<string, unknown>;
    const origin = `https://example.test:${servers.httpsPort}`;
    await bg({ type: 'saveSettings', settings: { ...settings, blockedOrigins: [origin] } });
    await openSite(https('example.test'));
    const res = await fillAttempt(ids.A);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('blocked');
    expect(await values()).toEqual({ user: '', pass: '' });
    await bg({ type: 'saveSettings', settings });
  });

  test('popup displays a TOTP equal to an independent RFC 6238 computation', async () => {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/index.html`);
    await popup.getByRole('button', { name: 'All items', exact: true }).click();
    await popup.getByRole('button', { name: /^TOTP site,/ }).click();
    const code = popup.getByRole('dialog', { name: 'Item detail' }).getByTestId('detail-totp');
    await expect(code).toHaveText(/^\d{6}$/);
    const shown = (await code.innerText()).trim();
    const t = Math.floor(Date.now() / 1000);
    // Allow the 30 s window to roll over between render and comparison.
    const expected = new Set([referenceTotp(RFC_SECRET_ASCII, t), referenceTotp(RFC_SECRET_ASCII, t - 30)]);
    expect(expected.has(shown)).toBe(true);
    await popup.close();
  });

  test('wrong passphrase is rejected; manual lock then unlock via UI', async () => {
    expect(await bg({ type: 'lock' })).toMatchObject({ ok: true, unlocked: false });
    expect((await bg({ type: 'listAll' })).ok).toBe(false);
    await openSite(https('example.test'));
    expect(await fillAttempt(ids.A)).toMatchObject({ ok: false, error: 'Vault is locked. Unlock it first.' });
    expect(await values()).toEqual({ user: '', pass: '' });

    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/index.html`);
    await popup.fill('#master-passphrase', PASSPHRASE + 'x');
    await popup.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(popup.getByRole('alert')).toContainText('Wrong passphrase');
    await popup.fill('#master-passphrase', PASSPHRASE);
    await popup.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(popup.getByRole('button', { name: 'Lock', exact: true })).toBeVisible({ timeout: 60_000 });
    await popup.close();
    expect(await fillAttempt(ids.A)).toEqual({ ok: true, filled: true });
  });

  test('recovery key unlocks the vault', async () => {
    await bg({ type: 'lock' });
    expect(await bg({ type: 'unlockRecovery', recoveryKey: 'A'.repeat(43) })).toMatchObject({ ok: true, unlocked: false });
    expect(await bg({ type: 'unlockRecovery', recoveryKey })).toMatchObject({ ok: true, unlocked: true });
  });

  test('auto-lock: the 1-minute alarm locks the vault (worker not restarted)', async () => {
    test.setTimeout(240_000);
    const settings = (await bg({ type: 'getSettings' })).settings as Record<string, unknown>;
    await bg({ type: 'saveSettings', settings: { ...settings, autoLockMinutes: 1 } });
    // Marker proves the worker was not terminated/restarted (which would also lock).
    await sw.evaluate(() => { (globalThis as unknown as { __e2eMarker: number }).__e2eMarker = 42; });
    expect(await bg({ type: 'unlock', passphrase: PASSPHRASE })).toMatchObject({ unlocked: true });
    const alarm = await sw.evaluate(async () => (await chrome.alarms.getAll()).find((a) => a.name === 'my-secrect-autolock'));
    expect(alarm).toBeTruthy();
    expect(alarm!.scheduledTime - Date.now()).toBeGreaterThan(30_000);
    expect(alarm!.scheduledTime - Date.now()).toBeLessThanOrEqual(61_000);
    expect(((await bg({ type: 'getStatus' })).status as { locked: boolean }).locked).toBe(false);
    await expect
      .poll(async () => ((await bg({ type: 'getStatus' })).status as { locked: boolean }).locked, { timeout: 100_000, intervals: [2_000] })
      .toBe(true);
    expect(await sw.evaluate(() => (globalThis as unknown as { __e2eMarker?: number }).__e2eMarker)).toBe(42);
    expect((await bg({ type: 'listAll' })).ok).toBe(false);
    await bg({ type: 'saveSettings', settings });
  });
});
