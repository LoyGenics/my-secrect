/**
 * Real-browser E2E for the "Restore backup" flow (apps/web -> shared desktop App).
 *
 * Boots its own Vite preview server (port E2E_RESTORE_WEB_PORT, default 5203), drives real Chromium via
 * Playwright, creates a vault, exports an encrypted backup THROUGH THE UI
 * (real download), then restores into fresh browser contexts (empty
 * localStorage) and runs negative cases. Nothing is mocked: real Argon2id,
 * real libsodium in the page.
 *
 * Run:  npx tsx --test tests/e2e-web-restore/restore.e2e.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const PORT = Number(process.env.E2E_RESTORE_WEB_PORT ?? 5203);
const URL_BASE = `http://127.0.0.1:${PORT}/`;
const PASS = 'correct horse battery staple 42';
const LS_KEYS = 'my-secrect.local-vault.v1.keys';
const LS_ROWS = 'my-secrect.local-vault.v1';
const shotDir = path.join(here, 'screenshots');
mkdirSync(shotDir, { recursive: true });

let server: ChildProcess;
let browser: Browser;
let backupText = '';
let recoveryKey = '';
let downloadedPath = '';

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(URL_BASE);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`vite did not start on ${PORT}`);
}

before(async () => {
  // Serve the BUILT app (apps/web/dist; run `npm --workspace apps/web run build` first).
  if (!existsSync(path.join(root, 'apps/web/dist/index.html'))) throw new Error('apps/web/dist missing: build the web app first');
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: path.join(root, 'apps/web'),
    stdio: 'ignore',
  });
  await waitForServer();
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.kill('SIGTERM');
});

async function freshPage(): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1200, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(URL_BASE);
  return { ctx, page };
}

async function storageSnapshot(page: Page): Promise<{ keys: string | null; rows: string | null }> {
  return page.evaluate(([k, r]) => ({ keys: localStorage.getItem(k), rows: localStorage.getItem(r) }), [LS_KEYS, LS_ROWS]);
}

async function openRestore(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Restore from backup' }).click();
  await page.getByTestId('restore-backup').waitFor();
}

async function attemptRestore(
  page: Page,
  text: string,
  mode: 'passphrase' | 'recovery',
  secret: string,
): Promise<void> {
  await page.setInputFiles('#restore-file', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await page.getByRole('radio', { name: mode === 'passphrase' ? 'Passphrase' : 'Recovery key' }).click();
  await page.locator('#restore-secret').fill(secret);
  await page.getByRole('button', { name: 'Restore backup', exact: true }).click();
}

async function expectRejected(page: Page, text: string, mode: 'passphrase' | 'recovery', secret: string, re: RegExp, shot: string) {
  const before = await storageSnapshot(page);
  await attemptRestore(page, text, mode, secret);
  const err = page.getByTestId('restore-error');
  await err.waitFor({ timeout: 60_000 });
  const msg = (await err.textContent()) ?? '';
  assert.match(msg, re, `unexpected error text: ${msg}`);
  assert.equal(await page.getByTestId('restore-success').count(), 0, 'must not report success');
  assert.deepEqual(await storageSnapshot(page), before, 'storage must be unchanged');
  await page.screenshot({ path: path.join(shotDir, `${shot}.png`) });
}

function flipBit(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  buf[buf.length - 1] ^= 0x01; // last byte: inside the AEAD tag
  return buf.toString('base64');
}

test('create vault, add items, export encrypted backup via UI', async () => {
  const { ctx, page } = await freshPage();
  await page.screenshot({ path: path.join(shotDir, '01-onboarding.png') });
  await page.locator('#new-pass').fill(PASS);
  await page.locator('#new-pass-confirm').fill(PASS);
  await page.getByRole('button', { name: 'Create vault' }).click();
  await page.getByText('Save this recovery key').waitFor({ timeout: 60_000 });
  recoveryKey = ((await page.locator('div.font-mono').first().textContent()) ?? '').trim();
  assert.match(recoveryKey, /^[A-Za-z0-9_-]{43}$/);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Open vault' }).click();

  for (const title of ['Restore Test Alpha', 'Restore Test Beta']) {
    await page.getByRole('button', { name: '+ New item' }).click();
    await page.locator('#item-title').fill(title);
    await page.getByLabel('Password', { exact: true }).first().fill('s3cret-' + title);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText(title).first().waitFor();
  }

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.getByRole('button', { name: /Export encrypted backup/ }).click();
      await page.locator('#step-up-passphrase').fill(PASS);
      await page.locator('form button[type="submit"]').filter({ hasText: /.+/ }).last().click();
    })(),
  ]);
  downloadedPath = (await download.path()) ?? '';
  assert.ok(downloadedPath, 'download saved');
  backupText = readFileSync(downloadedPath, 'utf8');
  const parsed = JSON.parse(backupText);
  assert.equal(parsed.format_version, 3);
  assert.equal(typeof parsed.item_index?.sealed, 'string', 'v3 carries the sealed item index');
  assert.equal(parsed.items.length, 2);
  assert.ok(!backupText.includes('Restore Test Alpha'), 'backup must not contain plaintext titles');
  assert.ok(!backupText.includes(recoveryKey), 'backup must not contain recovery key');
  await ctx.close();
});

test('restore with passphrase on fresh profile, then normal unlock shows items', async () => {
  const { ctx, page } = await freshPage();
  assert.deepEqual(await storageSnapshot(page), { keys: null, rows: null });
  await openRestore(page);
  await attemptRestore(page, backupText, 'passphrase', PASS);
  await page.getByTestId('restore-success').waitFor({ timeout: 60_000 });
  assert.match((await page.getByTestId('restore-success').textContent()) ?? '', /2 items/);
  assert.equal(await page.getByTestId('restore-item-list-unverified').count(), 0, 'a v3 backup is verified: no legacy warning');
  await page.screenshot({ path: path.join(shotDir, '02-restore-success.png') });
  await page.getByRole('button', { name: 'Continue to unlock' }).click();
  // Locked: normal unlock required, items not visible yet.
  await page.getByText('Your vault is locked').waitFor();
  assert.equal(await page.getByText('Restore Test Alpha').count(), 0);
  await page.locator('#lock-passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByText('Restore Test Alpha').first().waitFor({ timeout: 60_000 });
  await page.getByText('Restore Test Beta').first().waitFor();
  await page.screenshot({ path: path.join(shotDir, '03-unlocked-after-restore.png') });
  await ctx.close();
});

test('restore with recovery key on fresh profile, unlock with recovery key', async () => {
  const { ctx, page } = await freshPage();
  await openRestore(page);
  await attemptRestore(page, backupText, 'recovery', recoveryKey);
  await page.getByTestId('restore-success').waitFor({ timeout: 60_000 });
  assert.match((await page.getByTestId('restore-success').textContent()) ?? '', /2 items/);
  await page.getByRole('button', { name: 'Continue to unlock' }).click();
  await page.getByText('Your vault is locked').waitFor();
  await page.getByRole('button', { name: /recovery key/i }).first().click();
  await page.locator('#lock-recovery-key').fill(recoveryKey);
  await page.getByRole('button', { name: 'Unlock with recovery key' }).click();
  await page.getByText('Restore Test Beta').first().waitFor({ timeout: 60_000 });
  await ctx.close();
});

test('negative cases leave storage unchanged and show specific errors', async () => {
  const { ctx, page } = await freshPage();
  await openRestore(page);
  const good = JSON.parse(backupText);

  await expectRejected(page, backupText, 'passphrase', 'wrong passphrase!!', /Could not open the backup with this passphrase/, '10-wrong-passphrase');
  await expectRejected(page, backupText, 'recovery', 'A'.repeat(43), /Could not open the backup with this recovery key/, '11-wrong-recovery-key');
  await expectRejected(page, backupText, 'recovery', 'tooshort', /not a valid recovery key/, '12-bad-recovery-key');

  const flipped = structuredClone(good);
  flipped.items[1].encrypted_payload = flipBit(flipped.items[1].encrypted_payload);
  await expectRejected(page, JSON.stringify(flipped), 'passphrase', PASS, /corrupted or has been tampered with/, '13-bit-flipped-item');

  const flippedKey = structuredClone(good);
  flippedKey.items[0].encrypted_item_key = flipBit(flippedKey.items[0].encrypted_item_key);
  await expectRejected(page, JSON.stringify(flippedKey), 'passphrase', PASS, /corrupted or has been tampered with/, '14-bit-flipped-item-key');

  const flippedVault = structuredClone(good);
  flippedVault.keys.wrapped_vault = flipBit(flippedVault.keys.wrapped_vault);
  await expectRejected(page, JSON.stringify(flippedVault), 'passphrase', PASS, /corrupted or has been tampered with/, '15-bit-flipped-vault-key');

  await expectRejected(page, backupText.slice(0, Math.floor(backupText.length / 2)), 'passphrase', PASS, /not a valid, complete backup[\s\S]*not valid JSON/, '16-truncated');

  const v4 = { ...good, format_version: 4 };
  await expectRejected(page, JSON.stringify(v4), 'passphrase', PASS, /Unsupported backup version[\s\S]*newer version/, '17-version-4');
  const v1 = { ...good, format_version: 1 };
  await expectRejected(page, JSON.stringify(v1), 'passphrase', PASS, /format_version 1 has no key envelope; restore needs a v2 backup/, '18-version-1');

  const dup = structuredClone(good);
  dup.items.push(structuredClone(dup.items[0]));
  await expectRejected(page, JSON.stringify(dup), 'passphrase', PASS, /same item id more than once/, '19-duplicate-ids');

  // DEFECT-K2-omission: one authentic row silently removed.
  const dropped = structuredClone(good);
  dropped.items.splice(0, 1);
  await expectRejected(page, JSON.stringify(dropped), 'passphrase', PASS, /item list does not match its authenticated index[\s\S]*Nothing was restored/, '19b-item-dropped');

  await expectRejected(page, '{"hello":"world"}', 'passphrase', PASS, /not a valid, complete backup|Unsupported backup version/, '20-not-a-backup');

  // Nothing was ever written.
  assert.deepEqual(await storageSnapshot(page), { keys: null, rows: null });
  await ctx.close();
});

test('legacy format_version 2 backup restores but the UI says the item list is not verifiable', async () => {
  const { ctx, page } = await freshPage();
  await openRestore(page);
  const { item_index: _index, ...body } = JSON.parse(backupText);
  await attemptRestore(page, JSON.stringify({ ...body, format_version: 2 }), 'passphrase', PASS);
  await page.getByTestId('restore-success').waitFor({ timeout: 60_000 });
  assert.match((await page.getByTestId('restore-success').textContent()) ?? '', /2 items/);
  const warning = page.getByTestId('restore-item-list-unverified');
  assert.match((await warning.textContent()) ?? '', /item list not verifiable[\s\S]*older version/);
  await page.screenshot({ path: path.join(shotDir, '04-legacy-v2-warning.png') });
  await ctx.close();
});

test('existing vault is never overwritten (created in another tab after this one loaded)', async () => {
  const { ctx, page } = await freshPage();
  await openRestore(page);
  // Same browser profile, second tab creates a vault -> storage becomes occupied.
  const other = await ctx.newPage();
  await other.goto(URL_BASE);
  await other.locator('#new-pass').fill('another passphrase 99');
  await other.locator('#new-pass-confirm').fill('another passphrase 99');
  await other.getByRole('button', { name: 'Create vault' }).click();
  await other.getByText('Save this recovery key').waitFor({ timeout: 60_000 });
  const occupied = await storageSnapshot(other);
  assert.ok(occupied.keys, 'second tab created a vault');
  await expectRejected(page, backupText, 'passphrase', PASS, /A vault already exists on this device[\s\S]*never overwrites/, '21-existing-vault');
  assert.deepEqual(await storageSnapshot(page), occupied, 'existing vault untouched byte-for-byte');
  await ctx.close();
});
