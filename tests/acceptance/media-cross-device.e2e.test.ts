/**
 * Acceptance F — media round trip on ANOTHER device.
 *
 * Real stack: Rails API + Postgres, throwaway MinIO (presigned URLs straight
 * from the browser), the web app in two independent Chromium profiles.
 * Device A uploads an encrypted file through the Media gallery. Device B is a
 * different browser profile: it signs in with the (synced) passkey, joins the
 * vault by restoring A's encrypted backup, receives the media item through
 * sync, and downloads + decrypts the file — bytes must be identical, and the
 * manifest must verify on B. Nothing is shared between the profiles except
 * the passkey and the backup file a user would carry over.
 *
 * Needs docker (MinIO image cgr.dev/chainguard/minio); skips with a reason otherwise.
 * Run: npx tsx --test --test-concurrency=1 tests/acceptance/media-cross-device.e2e.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startApi, startMinio, startWeb, type RunningApi, type RunningMinio } from './lib/stack.ts';
import { addPasskeyViaUi, createVaultViaUi, freshDevice, registerViaUi, restoreViaUi, signInViaUi, unlockViaUi, type VirtualAuthenticator } from './lib/browser.ts';

const API_PORT = Number(process.env.ACCEPT_F_API_PORT ?? 3256);
const WEB_PORT = Number(process.env.ACCEPT_F_WEB_PORT ?? 5369);
const MINIO_PORT = Number(process.env.ACCEPT_F_MINIO_PORT ?? 19702);
const WEB = `http://localhost:${WEB_PORT}`;
const DB = 'vault_f_a15_e2eauth';
const PASS = 'acceptance F passphrase 5';
const EMAIL = `f-media-${Date.now()}@example.test`;
const FILE_NAME = 'f-cross-device-scan.bin';
const bytes = randomBytes(2 * 1024 * 1024 + 12345); // 3 chunks, incompressible

let api: RunningApi;
let web: { stop(): Promise<void> };
let minio: RunningMinio | null = null;
let browser: Browser;
let A: { ctx: BrowserContext; page: Page; auth: VirtualAuthenticator };
let B: { ctx: BrowserContext; page: Page; auth: VirtualAuthenticator };
let backup = '';
const noDocker = () => (minio ? false : 'MinIO (docker) unavailable: media round trip NOT verified');

before(async () => {
  minio = process.env.ACCEPT_NO_DOCKER ? null : await startMinio(MINIO_PORT, WEB);
  if (!minio) return;
  api = await startApi({ port: API_PORT, db: DB, webOrigin: WEB, s3: minio });
  web = await startWeb(WEB_PORT);
  // Full Chromium, not chrome-headless-shell: the shell turns on macOS Secure Input.
  browser = await chromium.launch({ channel: 'chromium' });
});
after(async () => {
  await A?.ctx.close().catch(() => undefined);
  await B?.ctx.close().catch(() => undefined);
  await browser?.close();
  await web?.stop();
  await api?.stop();
  await minio?.stop();
});

test('device A: register, create vault, export the encrypted backup, upload an encrypted file', async (t) => {
  if (noDocker()) return t.skip(String(noDocker()));
  A = await freshDevice(browser, api.apiBase);
  const p = A.page;
  await registerViaUi(p, WEB, EMAIL, api.mailDir);
  await createVaultViaUi(p, PASS);
  await addPasskeyViaUi(p, EMAIL, api.mailDir);
  const [download] = await Promise.all([
    p.waitForEvent('download'),
    (async () => {
      await p.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
      await p.getByRole('button', { name: /Export encrypted backup/ }).first().click();
      await p.locator('#step-up-passphrase').fill(PASS);
      await p.locator('form button[type="submit"]').filter({ hasText: /.+/ }).last().click();
    })(),
  ]);
  backup = readFileSync((await download.path())!, 'utf8');
  const dir = mkdtempSync(path.join(tmpdir(), 'accept-f-'));
  const file = path.join(dir, FILE_NAME);
  writeFileSync(file, bytes);
  await p.getByRole('button', { name: /Media gallery/ }).click();
  await p.setInputFiles('[data-testid="media-upload-input"]', file);
  await p.getByText(new RegExp(`Uploaded “${FILE_NAME.replace(/\./g, '\\.')}” as encrypted chunks`)).waitFor({ timeout: 60_000 });
  await p.getByTestId('sync-status').and(p.locator('[data-state="idle"]')).waitFor({ timeout: 30_000 });
  assert.equal(minio!.listKeys().length, 3, 'three ciphertext chunks in the bucket');
});

test('device B (another browser profile): passkey sign-in, restore, sync, then download + decrypt the same bytes', async (t) => {
  if (noDocker()) return t.skip(String(noDocker()));
  assert.ok(backup, 'device A step failed');
  B = await freshDevice(browser, api.apiBase);
  await B.auth.importAll(await A.auth.exportAll());
  const p = B.page;
  await p.goto(WEB);
  await signInViaUi(p, EMAIL);
  await p.getByText('Create your local vault').waitFor();
  await restoreViaUi(p, backup, { passphrase: PASS });
  await unlockViaUi(p, PASS);
  await p.getByTestId('sync-status').and(p.locator('[data-state="idle"]')).waitFor({ timeout: 30_000 });
  await p.getByRole('button', { name: /Media gallery/ }).click();
  const tile = p.getByLabel(`Media item ${FILE_NAME}`);
  await tile.waitFor({ timeout: 30_000 });
  await tile.getByText('Manifest: verified').waitFor({ timeout: 30_000 });
  const [download] = await Promise.all([
    p.waitForEvent('download', { timeout: 60_000 }),
    tile.getByRole('button', { name: 'Download decrypted' }).click(),
  ]);
  assert.equal(download.suggestedFilename(), FILE_NAME);
  const got = readFileSync((await download.path())!);
  assert.equal(got.length, bytes.length);
  assert.ok(got.equals(bytes), 'B decrypted exactly the bytes A uploaded');
});
