/**
 * Browser-level check of the sync status indicator + Conflict list, in real
 * Chromium (Playwright), against the REAL web app (Vite, port 5202) and the
 * REAL Rails API (port 3102).
 *
 * The browser is "device A": its localStorage is seeded from a Node client's
 * persisted state (vault envelope + ciphertext rows + sync binding + session
 * token), so the page starts as an already signed-in device. Sign-in itself is
 * covered by two-clients.test.ts (real WebAuthn); here the vault is unlocked
 * through the real lock screen, edits go through the real item form, and the
 * conflict is created by a second real client (Node "device B") editing the
 * same item. Connectivity is cut with Playwright's context.setOffline.
 *
 * Run: npx tsx --test --test-concurrency=1 tests/sync-e2e/conflict-ui.test.ts
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { bootApi, pgDump, psql, PORT, RP_ID, WEB_ORIGIN, type RunningApi } from './api-harness.ts';
import { SoftwareAuthenticator } from './software-authenticator.ts';
import { Client } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '../../apps/web');
const PASS = 'browser passphrase 42 xyz';
const EMAIL = `sync-ui-${Date.now()}@example.test`;
const ITEM = 'item_ui1000000000000000000000';
const M = { base: 'UIMARK-BASE-1a1a', browser: 'UIMARK-BROWSER-2b2b', other: 'UIMARK-OTHER-3c3c', pwBrowser: 'UIMARK-PWB-4d4d', pwOther: 'UIMARK-PWO-5e5e' };

let api: RunningApi;
let vite: ChildProcess;
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let B: Client;
let seed: Record<string, string>;
const dir = mkdtempSync(path.join(tmpdir(), 'sync-ui-'));

before(async () => {
  api = await bootApi();
  const auth = SoftwareAuthenticator.create(WEB_ORIGIN, RP_ID);
  // Seed device ("A" persisted state), then discard that process: the browser takes over its state.
  const seedClient = new Client('seed', path.join(dir, 'seed.json')).start();
  await seedClient.call('register', { email: EMAIL, authenticator: auth.exportCredential() });
  await seedClient.call('createVault', { passphrase: PASS });
  const backup = await seedClient.call<string>('exportBackup');
  await seedClient.call('unlock', { passphrase: PASS });
  await seedClient.call('startSync');
  await seedClient.call('createItem', { id: ITEM, title: M.base, fields: { username: 'ui-user', password: 'UIMARK-PW-0' } });
  const st = await seedClient.call('syncNow');
  assert.equal(st.state, 'idle', JSON.stringify(st));
  seed = await seedClient.call<Record<string, string>>('rawStorage');
  await seedClient.kill();

  B = new Client('B', path.join(dir, 'b.json')).start();
  await B.call('restoreBackup', { json: backup, passphrase: PASS });
  const si = await B.call('signIn', { email: EMAIL, authenticator: auth.exportCredential() });
  assert.ok(si.signedIn);
  await B.call('unlock', { passphrase: PASS });
  await B.call('startSync');
  await B.call('syncNow');
  assert.equal((await B.find(M.base))?.id, ITEM);

  vite = spawn(path.resolve(here, '../../node_modules/.bin/vite'), ['--port', '5202', '--strictPort', '--host', 'localhost'], { cwd: webDir, stdio: 'ignore' });
  for (let i = 0; ; i++) {
    try { if ((await fetch('http://localhost:5202/')).ok) break; } catch { /* starting */ }
    if (i > 100) throw new Error('vite did not start');
    await new Promise((r) => setTimeout(r, 300));
  }
  browser = await chromium.launch();
  ctx = await browser.newContext();
  const token = seed['sync-e2e.token'];
  const toSeed: Record<string, string> = {};
  for (const [k, v] of Object.entries(seed)) if (k.startsWith('my-secrect.')) toSeed[k] = v;
  toSeed['my-secrect:api-base-url'] = `http://localhost:${PORT}/api`;
  toSeed['my-secrect:api-token'] = token;
  toSeed['my-secrect:account-email'] = EMAIL;
  await ctx.addInitScript((entries: Record<string, string>) => {
    if (!localStorage.getItem('__seeded')) {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
      localStorage.setItem('__seeded', '1');
    }
  }, toSeed);
  page = await ctx.newPage();
});

after(async () => {
  await browser?.close();
  vite?.kill('SIGKILL');
  await B?.kill();
  await api?.stop();
});

const status = () => page.getByTestId('sync-status');

test('unlock in the real UI -> sync indicator goes idle and shows the pulled item', async () => {
  await page.goto('http://localhost:5202/');
  await page.getByLabel('Master passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await status().waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('[data-testid=sync-status]')?.getAttribute('data-state') === 'idle', null, { timeout: 30_000 });
  await page.getByText(M.base).first().waitFor();
  await page.screenshot({ path: path.join(here, '.out', 'ui-1-idle.png') });
});

test('offline edit through the item form: indicator says Offline + pending, nothing reaches the server', async () => {
  await ctx.setOffline(true);
  await page.getByText(M.base).first().click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(M.browser);
  await page.locator('input[aria-label="Password"]').fill(M.pwBrowser);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid=sync-status]')?.getAttribute('data-state') === 'offline', null, { timeout: 30_000 });
  assert.match((await page.getByTestId('sync-error').innerText()), /Offline/);
  assert.match((await page.getByTestId('sync-pending').innerText()), /1 change/);
  assert.equal(psql(`SELECT current_revision FROM items`), '1');
  await page.screenshot({ path: path.join(here, '.out', 'ui-2-offline.png') });
});

test('device B edits the same item; browser reconnects -> conflict list shows BOTH decrypted versions', async () => {
  await B.call('editItem', { id: ITEM, title: M.other, fields: { password: M.pwOther } });
  assert.equal((await B.call('syncNow')).state, 'idle');
  assert.equal(psql(`SELECT current_revision FROM items`), '2');
  await ctx.setOffline(false);
  await page.getByRole('button', { name: 'Sync now' }).click();
  const list = page.getByTestId('conflict-list');
  await list.waitFor({ timeout: 30_000 });
  assert.equal(await page.getByTestId('conflict-item').count(), 1);
  const local = page.getByTestId('conflict-local');
  const remote = page.getByTestId('conflict-remote');
  assert.match(await local.innerText(), new RegExp(M.browser));
  assert.match(await remote.innerText(), new RegExp(M.other));
  assert.doesNotMatch(await local.innerText(), new RegExp(M.pwBrowser), 'values are masked until revealed');
  await local.getByRole('button', { name: 'Reveal values' }).click();
  await remote.getByRole('button', { name: 'Reveal values' }).click();
  assert.match(await local.innerText(), new RegExp(M.pwBrowser));
  assert.match(await remote.innerText(), new RegExp(M.pwOther));
  // only the lossless resolution is offered
  assert.equal(await page.getByRole('button', { name: /keep mine|keep theirs/i }).count(), 0);
  assert.equal(psql(`SELECT current_revision FROM items`), '2', 'server still has B\'s revision: the browser did not overwrite it');
  await page.screenshot({ path: path.join(here, '.out', 'ui-3-conflict.png') });
});

test('Keep both in the UI: nothing lost on the server, in the browser, or on device B; ciphertext only', async () => {
  await page.getByRole('button', { name: 'Keep both', exact: true }).click();
  await page.getByTestId('conflict-list').waitFor({ state: 'detached', timeout: 30_000 }); // no unresolved conflicts left: the panel closes
  await page.waitForFunction(() => document.querySelector('[data-testid=sync-status]')?.getAttribute('data-state') === 'idle', null, { timeout: 30_000 });
  await page.screenshot({ path: path.join(here, '.out', 'ui-4-resolved.png') });
  await B.call('syncNow');
  const items = (await B.call<any[]>('list')).filter((i) => !i.deleted_at);
  const mine = items.find((i) => i.id === ITEM);
  assert.equal(mine?.title, M.browser, 'browser version kept at the original item');
  assert.equal(mine?.fields.password, M.pwBrowser);
  const copy = items.find((i) => i.title === `${M.other} (conflict copy)`);
  assert.ok(copy, 'B version kept as a copy, visible on B');
  assert.equal(copy.fields.password, M.pwOther);
  // visible in the browser's own item list too
  await page.getByText(`${M.other} (conflict copy)`).first().waitFor();
  // browser storage holds no plaintext (rows + conflicts are encrypted)
  const ls = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage))));
  for (const m of Object.values(M)) assert.ok(!ls.includes(m), `plaintext ${m} in browser localStorage`);
  const dump = pgDump();
  const log = readFileSync(api.logPath, 'utf8');
  for (const m of Object.values(M)) { assert.ok(!dump.includes(m), `${m} in DB dump`); assert.ok(!log.includes(m), `${m} in API log`); }
});
