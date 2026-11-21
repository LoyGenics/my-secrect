/**
 * Acceptance E — portable backup restored on a fresh device, every item and
 * relation verified, in REAL Chromium.
 *
 * The web app (apps/web -> desktop App) runs on the Vite dev server with no
 * API configured (backup/restore is local-first). Profile A holds the
 * relation-rich data set from lib/vault-data.ts (typed relations, tags,
 * favorites, attachments, nested collections) — written through the SAME
 * vault module instance the app uses (dynamic import of the module URL in the
 * page), then re-read by the app after a reload + UI unlock — plus one item
 * created purely through the item form (tags, favorite, relation checkbox)
 * and one item moved to trash through the UI. Export goes through the UI
 * (step-up + real download). The downloaded file is restored through the UI
 * on brand-new browser profiles (passphrase, then recovery key) and through
 * the real MV3 extension's options page. Every restored item is compared
 * field-by-field with profile A; relations are checked in the item detail UI.
 *
 * Run: npx tsx --test --test-concurrency=1 tests/acceptance/portable-backup.e2e.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { repoRoot, startWeb } from './lib/stack.ts';
import { createVaultViaUi, restoreViaUi, unlockViaUi } from './lib/browser.ts';
import { IDS, byId, comparable, danglingReferences, richItems, trashedItem } from './lib/vault-data.ts';
import { buildExtension } from '../../apps/extension/e2e/fixtures.ts';
import type { VaultItem } from '../../packages/core/src/types';

const WEB_PORT = Number(process.env.ACCEPT_E_WEB_PORT ?? 5368);
const WEB = `http://localhost:${WEB_PORT}`;
const PASS = 'acceptance E passphrase 4';
const VAULT_URL = `/@fs${path.join(repoRoot, 'apps/desktop/src/vault.ts')}`;
const defect = (id: string) => (process.env.ACCEPTANCE_STRICT ? undefined : id);
const UI_TITLE = 'E UI-made login';

let web: { stop(): Promise<void> };
let browser: Browser;
let backup = '';
let recoveryKey = '';
let expected: VaultItem[] = [];
const open: BrowserContext[] = [];

before(async () => {
  web = await startWeb(WEB_PORT);
  // Full Chromium, not chrome-headless-shell: the shell turns on macOS Secure Input.
  browser = await chromium.launch({ channel: 'chromium' });
});
after(async () => {
  for (const c of open) await c.close().catch(() => undefined);
  await browser?.close();
  await web?.stop();
});

/** Later tests restore profile A's file: fail fast (not by a 60 s timeout) when it was never produced. */
function needBackup() { assert.ok(backup, 'profile A did not produce a backup; see the first failure'); }

async function freshProfile(): Promise<Page> {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  open.push(ctx);
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(WEB);
  return page;
}

/** The app's own vault module instance (same URL the app imported). */
const vaultItems = (page: Page) => page.evaluate(async (u) => {
  const v = await import(/* @vite-ignore */ u);
  if (!v.isUnlocked()) throw new Error('vault module instance is locked: not the app instance?');
  return v.listItems(true) as unknown[];
}, VAULT_URL) as Promise<VaultItem[]>;

async function openItem(page: Page, title: string) {
  await page.getByRole('button', { name: 'All items' }).click();
  await page.getByText(title, { exact: true }).first().click();
  await page.getByRole('heading', { name: 'Relations' }).waitFor();
}

test('profile A: relation-rich vault (module + item form), one item trashed in the UI, encrypted export via the UI', async () => {
  const page = await freshProfile();
  assert.deepEqual(await page.evaluate(() => [localStorage.getItem('my-secrect.local-vault.v1'), localStorage.getItem('my-secrect.local-vault.v1.keys')]), [null, null], 'fresh profile: no vault envelope or rows');
  recoveryKey = await createVaultViaUi(page, PASS);
  const seeded = await page.evaluate(async ([u, items]) => {
    const v = await import(/* @vite-ignore */ u as string);
    for (const it of items as unknown[]) await v.upsertItem(it);
    return v.listItems(true).length as number;
  }, [VAULT_URL, [...richItems('E'), trashedItem('E')]] as const);
  assert.equal(seeded, richItems().length + 1);
  // The app re-reads everything from storage: reload + unlock through the lock screen.
  await page.reload();
  await unlockViaUi(page, PASS);
  await page.getByText('E Main Bank').first().waitFor();

  // One item made entirely in the item form: tags, favorite, relation checkbox.
  await page.getByRole('button', { name: '+ New item' }).click();
  await page.locator('#item-title').fill(UI_TITLE);
  await page.locator('#item-tags').fill('ui, web');
  await page.locator('#item-favorite').check();
  await page.getByLabel('Password', { exact: true }).first().fill('ui-made-pw');
  await page.getByLabel('Relate to E Main Bank').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText(UI_TITLE).first().waitFor();

  // Trash one item through the UI.
  await page.getByRole('button', { name: 'All items' }).click();
  await page.getByText('E Old login (trashed)', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByText('E Old login (trashed)', { exact: true }).waitFor({ state: 'detached' });

  const all = await vaultItems(page);
  const uiItem = all.find((i) => i.title === UI_TITLE)!;
  assert.deepEqual(uiItem.tags, ['ui', 'web']);
  assert.equal(uiItem.favorite, true);
  assert.deepEqual(uiItem.relations.map((r) => r.target_id), [IDS.bank]);
  assert.ok(all.find((i) => i.id === IDS.trashed)?.deleted_at, 'trashed in the app');
  expected = all.filter((i) => !i.deleted_at);
  assert.equal(expected.length, richItems().length + 1);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.getByRole('button', { name: /Export encrypted backup/ }).click();
      await page.locator('#step-up-passphrase').fill(PASS);
      await page.locator('form button[type="submit"]').filter({ hasText: /.+/ }).last().click();
    })(),
  ]);
  backup = readFileSync((await download.path())!, 'utf8');
  const doc = JSON.parse(backup);
  assert.equal(doc.format_version, 3);
  assert.equal(typeof doc.item_index?.sealed, 'string', 'authenticated item index present');
  assert.equal(doc.items.length, expected.length, 'live items only');
  for (const marker of ['E Main Bank', 'Nguyễn', '4111111111111111', UI_TITLE, 'has_login', recoveryKey, PASS]) {
    assert.equal(backup.includes(marker), false, `plaintext "${marker}" in the backup file`);
  }
});

test('fresh profile B: restore with the passphrase, unlock, every item identical and every relation resolves in the UI', async () => {
  needBackup();
  const page = await freshProfile();
  assert.deepEqual(await page.evaluate(() => [localStorage.getItem('my-secrect.local-vault.v1'), localStorage.getItem('my-secrect.local-vault.v1.keys')]), [null, null], 'fresh profile: no vault envelope or rows');
  const msg = await restoreViaUi(page, backup, { passphrase: PASS });
  assert.match(msg, new RegExp(`${expected.length} items`));
  await unlockViaUi(page, PASS);
  const got = await vaultItems(page);
  assert.deepEqual(byId(got).map(comparable), byId(expected).map(comparable));
  assert.deepEqual(danglingReferences(got), []);
  for (const it of expected) await page.getByText(it.title, { exact: true }).first().waitFor();

  await openItem(page, 'E Main Bank');
  for (const target of ['E Bank login', 'E Debit card', 'E Me']) {
    // Relations render as their own region; each target is a button named by its title.
    await page.getByRole('region', { name: 'Relations' }).getByRole('button', { name: target, exact: true }).first().waitFor();
  }
  assert.equal(await page.getByText('(not found)').count(), 0, 'a relation target is missing after restore');
  await openItem(page, UI_TITLE);
  await page.getByRole('region', { name: 'Relations' }).getByRole('button', { name: 'E Main Bank', exact: true }).first().waitFor();
});

test('fresh profile C: restore with the recovery key, unlock with the recovery key, identical items', async () => {
  needBackup();
  const page = await freshProfile();
  await restoreViaUi(page, backup, { recoveryKey });
  await page.getByText('Your vault is locked').waitFor();
  await page.getByRole('button', { name: /recovery key/i }).first().click();
  await page.locator('#lock-recovery-key').fill(recoveryKey);
  await page.getByRole('button', { name: 'Unlock with recovery key' }).click();
  await page.getByRole('button', { name: /Lock vault/ }).waitFor({ timeout: 60_000 });
  assert.deepEqual(byId(await vaultItems(page)).map(comparable), byId(expected).map(comparable));
});

test('the same web backup restores in the real MV3 extension (options UI), every item identical', async () => {
  needBackup();
  const dist = buildExtension();
  const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'accept-e-ext-')), {
    channel: 'chromium', headless: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  open.push(ctx);
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/options/index.html`);
  await page.setInputFiles('#restore-file', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await page.getByRole('radio', { name: 'Passphrase' }).click();
  await page.locator('#restore-secret').fill(PASS);
  await page.getByRole('button', { name: 'Restore backup', exact: true }).click();
  await page.getByTestId('restore-success').waitFor({ timeout: 60_000 });
  const bg = (m: Record<string, unknown>) => page.evaluate((x) => chrome.runtime.sendMessage(x) as Promise<any>, m);
  assert.equal((await bg({ type: 'unlock', passphrase: PASS })).unlocked, true);
  const got: VaultItem[] = [];
  for (const it of expected) {
    const r = await bg({ type: 'getItem', id: it.id });
    assert.equal(r.ok, true, `getItem ${it.id}`);
    got.push(r.item);
  }
  assert.deepEqual(byId(got).map(comparable), byId(expected).map(comparable));
});

test('editing a restored item in the form and saving without changes keeps its typed relations', async () => {
  needBackup();
  const page = await freshProfile();
  await restoreViaUi(page, backup, { passphrase: PASS });
  await unlockViaUi(page, PASS);
  await openItem(page, 'E Main Bank');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('heading', { name: 'Relations' }).waitFor();
  const bank = (await vaultItems(page)).find((i) => i.id === IDS.bank)!;
  assert.deepEqual(bank.relations, expected.find((i) => i.id === IDS.bank)!.relations);
});
