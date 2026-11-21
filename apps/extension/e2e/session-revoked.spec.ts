/**
 * When the account session ends (server 401 or local expiry) while the vault
 * is UNLOCKED, the vault must lock — the owner rule is "no vault without an
 * account session".
 * Run: npm --workspace apps/extension run test:e2e
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildExtension, signInViaMessages, startMockApi, type MockApi } from './fixtures';

const PASSPHRASE = 'qa-revoked-Passphrase-Not-A-Real-Secret-5';
let ctx: BrowserContext;
let mockApi: MockApi;
let extId: string;
let admin: Page;
const bg = (m: Record<string, unknown>) =>
  admin.evaluate((x) => chrome.runtime.sendMessage(x) as Promise<Record<string, unknown>>, m);

test.describe.serial('session ends while unlocked', () => {
  test.beforeAll(async () => {
    const dist = buildExtension();
    mockApi = await startMockApi();
    ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'qa-revoked-')), {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    });
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
    extId = new URL(sw.url()).host;
    admin = await ctx.newPage();
    await admin.goto(`chrome-extension://${extId}/options/index.html`);
    await signInViaMessages(bg, mockApi.base);
    expect((await bg({ type: 'createVault', passphrase: PASSPHRASE })).ok).toBe(true);
  });
  test.afterAll(async () => { await ctx?.close(); await mockApi?.close(); });

  test('server 401 locks an unlocked vault', async () => {
    expect((await bg({ type: 'getStatus' })).status).toMatchObject({ locked: false });
    mockApi.expireAll();
    expect(((await bg({ type: 'getAccount' })).account as { step: string }).step).toBe('signed-out');
    expect((await bg({ type: 'getStatus' })).status).toMatchObject({ locked: true });
    expect((await bg({ type: 'listAll' })).ok).toBe(false);
  });

  test('popup does not show the vault after the session is gone', async () => {
    await signInViaMessages(bg, mockApi.base, 'again@example.test');
    expect((await bg({ type: 'unlock', passphrase: PASSPHRASE })).unlocked).toBe(true);
    mockApi.expireAll();
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/index.html`);
    await expect(popup.getByRole('heading', { name: 'Sign in to My Secret' })).toBeVisible();
    expect((await bg({ type: 'listAll' })).ok).toBe(false);
    await popup.close();
  });

  test('local expiry locks an unlocked vault', async () => {
    await signInViaMessages(bg, mockApi.base, 'expiry@example.test');
    expect((await bg({ type: 'unlock', passphrase: PASSPHRASE })).unlocked).toBe(true);
    await admin.evaluate(async () => {
      const key = 'my-secrect.ext.account.v1';
      const rec = (await chrome.storage.session.get(key))[key] as { session: { expiresAt: number } };
      rec.session.expiresAt = Date.now() - 1;
      await chrome.storage.session.set({ [key]: rec });
    });
    expect((await bg({ type: 'getStatus' })).status).toMatchObject({ locked: true });
    expect(((await bg({ type: 'getAccount' })).account as { step: string }).step).toBe('signed-out');
  });

  test('a forged session record for the real server is checked with the server and refused', async () => {
    await admin.evaluate(async (base) => {
      await chrome.storage.session.set({
        'my-secrect.ext.account.v1': { apiBaseUrl: base, email: 'x@example.test', session: { token: 'sess_forged', expiresAt: Date.now() + 86_400_000 } },
      });
    }, mockApi.base);
    expect(await bg({ type: 'unlock', passphrase: PASSPHRASE })).toMatchObject({ ok: false, authError: 'signed-out' });
    expect((await bg({ type: 'getStatus' })).status).toMatchObject({ locked: true });
  });
});
