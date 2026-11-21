/**
 * Forged-session variants against the vault gate (from extension QA round 2):
 * rejected real-looking token, revoked token written back, popup writing
 * storage.session, forged record + server down after a worker restart, and
 * an unreachable / empty server URL.
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildExtension, signInViaMessages, startMockApi, type MockApi } from './fixtures';

const PASSPHRASE = 'qa-variants-Passphrase-Not-A-Real-Secret-9';
const KEY = 'my-secrect.ext.account.v1';
const SIGNED_OUT = { ok: false, authError: 'signed-out' };
let ctx: BrowserContext;
let api: MockApi;
let extId: string;
let admin: Page;
const bg = (m: Record<string, unknown>) =>
  admin.evaluate((x) => chrome.runtime.sendMessage(x) as Promise<Record<string, unknown>>, m);
const forge = (page: Page, rec: unknown) =>
  page.evaluate(async ([k, r]) => { await chrome.storage.session.set({ [k as string]: r }); }, [KEY, rec] as const);
const record = (base: string, token: string) =>
  ({ apiBaseUrl: base, email: 'x@example.test', session: { token, expiresAt: Date.now() + 86_400_000 } });

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

test.describe.serial('forged session variants', () => {
  test.beforeAll(async () => {
    const dist = buildExtension();
    api = await startMockApi();
    ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'qa-variants-')), {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    });
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
    extId = new URL(sw.url()).host;
    admin = await ctx.newPage();
    await admin.goto(`chrome-extension://${extId}/options/index.html`);
    await signInViaMessages(bg, api.base);
    expect((await bg({ type: 'createVault', passphrase: PASSPHRASE })).ok).toBe(true);
    await bg({ type: 'signOut' });
    expect((await bg({ type: 'getStatus' })).status).toMatchObject({ locked: true, vaultExists: true });
  });
  test.afterAll(async () => { await ctx?.close(); await api?.close(); });

  test('real-looking token the server rejects: asked the server, refused', async () => {
    const token = `sess_${randomBytes(32).toString('hex')}`;
    await forge(admin, record(api.base, token));
    const before = api.requests.length;
    for (const req of [{ type: 'unlock', passphrase: PASSPHRASE }, { type: 'createVault', passphrase: 'x-y-z-Not-Real-1' }]) {
      expect(await bg(req)).toMatchObject(SIGNED_OUT);
    }
    expect(api.requests.slice(before).some((r) => r.method === 'GET' && r.path === '/v1/auth/sessions')).toBe(true);
    expect((await bg({ type: 'getStatus' })).status).toMatchObject({ locked: true });
  });

  test('a revoked (signed-out) real token replayed into storage.session is refused', async () => {
    await signInViaMessages(bg, api.base, 'replay@example.test');
    const rec = await admin.evaluate(async (k) => (await chrome.storage.session.get(k))[k], KEY);
    await bg({ type: 'signOut' });
    await forge(admin, rec);
    expect(await bg({ type: 'unlock', passphrase: PASSPHRASE })).toMatchObject(SIGNED_OUT);
  });

  test('the popup page writing storage.session directly gets nothing', async () => {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/index.html`);
    await forge(popup, record(api.base, `sess_${randomBytes(32).toString('hex')}`));
    const r = await popup.evaluate((p) => chrome.runtime.sendMessage({ type: 'unlock', passphrase: p }), PASSPHRASE);
    expect(r).toMatchObject(SIGNED_OUT);
    await popup.close();
  });

  test('forged record + server unreachable after a worker restart: refused (fails closed)', async () => {
    await restartWorker();
    await forge(admin, record(api.base, `sess_${randomBytes(32).toString('hex')}`));
    await api.close();
    expect(await bg({ type: 'unlock', passphrase: PASSPHRASE })).toMatchObject(SIGNED_OUT);
    expect(await bg({ type: 'unlockRecovery', recoveryKey: 'AAAA' })).toMatchObject(SIGNED_OUT);
    expect((await bg({ type: 'getStatus' })).status).toMatchObject({ locked: true });
  });

  test('forged record for an unreachable server URL: refused', async () => {
    const dead = 'http://127.0.0.1:9/api';
    expect((await bg({ type: 'setApiBaseUrl', url: dead })).ok).toBe(true);
    await forge(admin, record(dead, `sess_${randomBytes(32).toString('hex')}`));
    expect(await bg({ type: 'unlock', passphrase: PASSPHRASE })).toMatchObject(SIGNED_OUT);
    await forge(admin, record('', 'forged'));
    expect(await bg({ type: 'unlock', passphrase: PASSPHRASE })).toMatchObject(SIGNED_OUT);
  });
});
