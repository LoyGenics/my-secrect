/**
 * Real-Chromium e2e: restore an encrypted backup into the built MV3 extension
 * through the options page UI. Profile A creates a vault + items and exports
 * (background messages, same path the options "Download encrypted backup"
 * button uses). Fresh profile B restores through the real UI. Every profile
 * signs in to an account first (vault access needs one): email code against
 * the e2e mock account server (apps/extension/e2e/fixtures.ts).
 * Run: npx tsx --test tests/e2e-web-restore/extension-restore.e2e.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { buildExtension, signInViaMessages, startMockApi, type MockApi } from '../../apps/extension/e2e/fixtures';

const here = path.dirname(fileURLToPath(import.meta.url));
const shotDir = path.join(here, 'screenshots');
mkdirSync(shotDir, { recursive: true });
const PASS = 'ext-restore-passphrase-fixture-77';

let dist = '';
let mockApi: MockApi;
let backup = '';
let recoveryKey = '';
const open: BrowserContext[] = [];

before(async () => { dist = buildExtension(); mockApi = await startMockApi(); });
after(async () => { for (const c of open) await c.close().catch(() => undefined); await mockApi?.close(); });

async function launch(): Promise<{ ctx: BrowserContext; extId: string; admin: Page }> {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'restore-profile-')), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  open.push(ctx);
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  const admin = await ctx.newPage();
  await admin.goto(`chrome-extension://${extId}/options/index.html`);
  await signInViaMessages((m) => bg(admin, m), mockApi.base);
  await admin.reload(); // the options page reads the account state on load
  return { ctx, extId, admin };
}

const bg = (p: Page, msg: Record<string, unknown>) =>
  p.evaluate((m) => chrome.runtime.sendMessage(m) as Promise<Record<string, any>>, msg);

// Snapshot of vault storage. The options page lazily writes its own UI
// settings key on load (async, unrelated to the vault), which made the
// snapshot racy; exclude only that key so every vault key is still compared.
async function storage(p: Page): Promise<string> {
  return p.evaluate(() => new Promise<string>((r) => chrome.storage.local.get(null, (v) => {
    const vault: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) if (k !== 'my-secrect.ext.settings.v1') vault[k] = v[k];
    r(JSON.stringify(vault));
  })));
}

function flipBit(b64: string): string {
  const b = Buffer.from(b64, 'base64'); b[b.length - 1] ^= 1; return b.toString('base64');
}

async function attempt(p: Page, text: string, mode: 'passphrase' | 'recovery', secret: string) {
  await p.setInputFiles('#restore-file', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await p.getByRole('radio', { name: mode === 'passphrase' ? 'Passphrase' : 'Recovery key' }).click();
  await p.locator('#restore-secret').fill(secret);
  await p.getByRole('button', { name: 'Restore backup', exact: true }).click();
}

async function rejected(p: Page, text: string, mode: 'passphrase' | 'recovery', secret: string, re: RegExp, shot: string) {
  const before = await storage(p);
  await attempt(p, text, mode, secret);
  const el = p.getByTestId('restore-error');
  await el.waitFor({ timeout: 60_000 });
  assert.match((await el.textContent()) ?? '', re);
  assert.equal(await p.getByTestId('restore-success').count(), 0);
  assert.equal(await storage(p), before, 'storage unchanged');
  await p.screenshot({ path: path.join(shotDir, `${shot}.png`) });
}

test('profile A: create vault, add items, export encrypted', async () => {
  const { admin } = await launch();
  const created = await bg(admin, { type: 'createVault', passphrase: PASS });
  recoveryKey = created.recoveryKey;
  assert.match(recoveryKey, /^[A-Za-z0-9_-]{43}$/);
  const now = new Date().toISOString();
  for (const title of ['Ext Alpha', 'Ext Beta', 'Ext Gamma']) {
    const r = await bg(admin, { type: 'saveLogin', item: { id: crypto.randomUUID(), type: 'login', schema_version: 1, title, fields: { username: 'u', password: 'pw-' + title, url: 'https://example.test' }, tags: [], relations: [], attachments: [], created_at: now, updated_at: now } });
    assert.equal(r.ok, true);
  }
  const ex = await bg(admin, { type: 'exportEncrypted' });
  backup = ex.json;
  assert.equal(JSON.parse(backup).items.length, 3);
  assert.equal(JSON.parse(backup).format_version, 3);
  assert.ok(!backup.includes('Ext Alpha'));
});

test('fresh profile: restore via options UI with passphrase, then normal unlock', async () => {
  const { admin, extId, ctx } = await launch();
  await admin.getByTestId('restore-backup').waitFor();
  await admin.screenshot({ path: path.join(shotDir, '30-ext-options-restore.png') });
  await attempt(admin, backup, 'passphrase', PASS);
  await admin.getByTestId('restore-success').waitFor({ timeout: 60_000 });
  assert.match((await admin.getByTestId('restore-success').textContent()) ?? '', /3 items/);
  assert.equal(await admin.getByTestId('restore-item-list-unverified').count(), 0, 'v3: item list verified, no warning');
  await admin.screenshot({ path: path.join(shotDir, '31-ext-restore-success.png') });
  const st = await bg(admin, { type: 'getStatus' });
  assert.deepEqual(st.status, { locked: true, vaultExists: true });
  assert.equal((await bg(admin, { type: 'listAll' })).ok, false, 'locked: no items readable');
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/index.html`);
  await popup.getByLabel('Master passphrase').fill(PASS);
  await popup.getByRole('button', { name: 'Unlock', exact: true }).click();
  await popup.getByText('Ext Beta').first().waitFor({ timeout: 60_000 });
});

test('fresh profile: restore with recovery key, unlock via recovery key', async () => {
  const { admin } = await launch();
  await attempt(admin, backup, 'recovery', recoveryKey);
  await admin.getByTestId('restore-success').waitFor({ timeout: 60_000 });
  assert.match((await admin.getByTestId('restore-success').textContent()) ?? '', /3 items/);
  assert.equal((await bg(admin, { type: 'unlockRecovery', recoveryKey })).unlocked, true);
  const all = await bg(admin, { type: 'listAll' });
  assert.equal(all.items.length, 3);
});

test('negative cases keep storage unchanged', async () => {
  const { admin } = await launch();
  const good = JSON.parse(backup);
  await rejected(admin, backup, 'passphrase', 'nope nope nope', /Could not open the backup with this passphrase/, '40-ext-wrong-pass');
  await rejected(admin, backup, 'recovery', 'B'.repeat(43), /Could not open the backup with this recovery key/, '41-ext-wrong-recovery');
  const t = structuredClone(good); t.items[2].encrypted_payload = flipBit(t.items[2].encrypted_payload);
  await rejected(admin, JSON.stringify(t), 'passphrase', PASS, /corrupted or has been tampered with/, '42-ext-bitflip');
  await rejected(admin, backup.slice(0, backup.length >> 1), 'passphrase', PASS, /not valid JSON/, '43-ext-truncated');
  await rejected(admin, JSON.stringify({ ...good, format_version: 9 }), 'passphrase', PASS, /Unsupported backup version[\s\S]*newer version/, '44-ext-version');
  const d = structuredClone(good); d.items.push(structuredClone(d.items[0]));
  await rejected(admin, JSON.stringify(d), 'passphrase', PASS, /same item id more than once/, '45-ext-dup');
  const dropped = structuredClone(good); dropped.items.splice(1, 1);
  await rejected(admin, JSON.stringify(dropped), 'passphrase', PASS, /item list does not match its authenticated index[\s\S]*Nothing was restored/, '46-ext-item-dropped');
  assert.equal((await bg(admin, { type: 'getStatus' })).status.vaultExists, false, 'still no vault');
});

test('fresh profile: legacy format_version 2 restores and the UI says the item list is not verifiable', async () => {
  const { admin } = await launch();
  const { item_index: _index, ...body } = JSON.parse(backup);
  await attempt(admin, JSON.stringify({ ...body, format_version: 2 }), 'passphrase', PASS);
  await admin.getByTestId('restore-success').waitFor({ timeout: 60_000 });
  assert.match((await admin.getByTestId('restore-item-list-unverified').textContent()) ?? '', /item list not verifiable[\s\S]*older version/);
  await admin.screenshot({ path: path.join(shotDir, '47-ext-legacy-v2-warning.png') });
});

test('existing vault: restore UI refuses and the background never overwrites', async () => {
  const { ctx, extId, admin } = await launch();
  await bg(admin, { type: 'createVault', passphrase: 'existing-vault-pass-1' });
  await bg(admin, { type: 'lock' });
  const before = await storage(admin);
  const r = await bg(admin, { type: 'restoreBackup', json: backup, passphrase: PASS });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /vault storage is not empty/);
  assert.equal(await storage(admin), before);
  const fresh = await ctx.newPage();
  await fresh.goto(`chrome-extension://${extId}/options/index.html`);
  await fresh.getByText('A vault already exists in this extension').waitFor();
  await fresh.screenshot({ path: path.join(shotDir, '46-ext-existing.png') });
});
