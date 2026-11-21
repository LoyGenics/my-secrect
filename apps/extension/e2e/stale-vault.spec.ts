/**
 * A vault written by the PRE-sign-in extension (e23bccf) and left in
 * chrome.storage.local cannot be unlocked, recovered, restored over, or
 * replaced without an account session — before and after a worker restart,
 * and not with a forged session record either. Fixture: stale-vault.json,
 * produced by the old build (test passphrase/recovery key only).
 * Run: npm --workspace apps/extension run test:e2e
 */
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildExtension } from './fixtures';

const fx = JSON.parse(readFileSync(new URL('./stale-vault.json', import.meta.url), 'utf8')) as {
  passphrase: string; recoveryKey: string; itemId: string; storage: Record<string, unknown>; exportJson: string;
};

let ctx: BrowserContext;
let extId: string;
let admin: Page;
const worker = (): Worker => ctx.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${extId}/`))!;
const bg = (m: Record<string, unknown>) =>
  admin.evaluate((x) => chrome.runtime.sendMessage(x) as Promise<Record<string, unknown>>, m);

async function assertNothingOpens(): Promise<void> {
  const status = (await bg({ type: 'getStatus' })).status as Record<string, unknown>;
  expect(status.locked).toBe(true);
  expect(status.vaultExists).toBe(true);
  for (const req of [
    { type: 'unlock', passphrase: fx.passphrase },
    { type: 'unlockRecovery', recoveryKey: fx.recoveryKey },
  ]) {
    const r = await bg(req);
    expect(r.unlocked, JSON.stringify(r)).not.toBe(true);
  }
  expect((await bg({ type: 'getStatus' })).status).toMatchObject({ locked: true });
  for (const req of [{ type: 'listAll' }, { type: 'getItem', id: fx.itemId }, { type: 'exportEncrypted' }]) {
    expect((await bg(req)).ok, JSON.stringify(req)).toBe(false);
  }
}

async function restartWorker(): Promise<void> {
  const cdp = await ctx.newCDPSession(admin);
  const versions = new Map<string, { versionId: string; scriptURL: string; runningStatus: string }>();
  cdp.on('ServiceWorker.workerVersionUpdated', (e) => { for (const v of e.versions) versions.set(v.versionId, v); });
  await cdp.send('ServiceWorker.enable');
  const ours = () => [...versions.values()].find((v) => v.scriptURL === `chrome-extension://${extId}/background.js`);
  await expect.poll(() => ours()?.runningStatus).toBe('running');
  await cdp.send('ServiceWorker.stopWorker', { versionId: ours()!.versionId });
  await expect.poll(() => ours()?.runningStatus).toBe('stopped');
}

test.describe.serial('stale pre-sign-in vault', () => {
  test.beforeAll(async () => {
    const dist = buildExtension();
    ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'qa-stale-run-')), {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    });
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
    extId = new URL(sw.url()).host;
    // Simulate an upgrade: the old version's storage is already there.
    await sw.evaluate((s) => chrome.storage.local.set(s), fx.storage);
    admin = await ctx.newPage();
    await admin.goto(`chrome-extension://${extId}/options/index.html`);
  });
  test.afterAll(async () => { await ctx?.close(); });

  test('signed out: correct passphrase and recovery key do not unlock the old vault', async () => {
    await assertNothingOpens();
  });

  test('popup shows sign-in, never the passphrase unlock form', async () => {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/index.html`);
    await popup.waitForLoadState('domcontentloaded');
    await popup.waitForTimeout(1500);
    expect(await popup.locator('input[type="password"]').count()).toBe(0);
    await popup.close();
  });

  test('after a worker restart the old vault still does not open', async () => {
    await restartWorker();
    await assertNothingOpens();
  });

  test('a forged "signed in" flag written by an extension page does not open it', async () => {
    // Any extension page can write storage.local / storage.session directly.
    await admin.evaluate(async () => {
      await chrome.storage.local.set({ signedIn: true, session: { token: 'forged' }, 'my-secrect.ext.session.v1': { token: 'forged', email: 'x@example.test' } });
      const forged = { email: 'x@example.test', session: { token: 'forged', expiresAt: Date.now() + 86_400_000 } };
      try {
        // The record shape lib/account.ts trusts, for the build-default ('') server.
        await chrome.storage.session.set({ signedIn: true, token: 'forged', 'my-secrect.ext.account.v1': { apiBaseUrl: '', ...forged } });
      } catch { /* restricted */ }
    });
    await restartWorker();
    await assertNothingOpens();
  });

  test('wipe then create, and restore of the old backup, are refused while signed out', async () => {
    const before = await worker().evaluate(() => chrome.storage.local.get(null));
    expect((await bg({ type: 'createVault', passphrase: 'qa-new-Passphrase-Not-Real-2' })).ok).toBe(false);
    await bg({ type: 'wipeVault' });
    expect((await bg({ type: 'createVault', passphrase: 'qa-new-Passphrase-Not-Real-2' })).ok).toBe(false);
    expect((await bg({ type: 'restoreBackup', json: fx.exportJson, passphrase: fx.passphrase })).ok).toBe(false);
    expect((await bg({ type: 'restoreBackup', json: fx.exportJson, recoveryKey: fx.recoveryKey })).ok).toBe(false);
    const after = await worker().evaluate(() => chrome.storage.local.get(null));
    expect(Object.keys(after).filter((k) => k.includes('vault'))).toEqual([]);
    expect(Object.keys(before).some((k) => k.includes('vault'))).toBe(true);
  });
});
