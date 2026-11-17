// Real-browser check of the shared MediaView (web client) against the real
// stack: Chromium via Playwright, real Rails API, real MinIO through the
// public presigned endpoint. Run via `E2E_BROWSER=1 tests/media-e2e/run.sh`.
//
// Asserts, from the browser's own network traffic, that no request body
// leaving the page contains plaintext file bytes, the file name or the
// thumbnail; that the uploaded file is listed with a verified manifest and a
// client-side thumbnail stored as its OWN encrypted blob and decrypted when
// the tile is shown; that View shows the decrypted image and revokes its
// object URL on close; that Download restores the exact bytes; that a byte
// flipped on the wire, or a connection cut mid-download, is rejected loudly
// with nothing saved; and that an upload cut mid-way resumes and sends only
// the missing part.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const need = (n) => { const v = process.env[n]; if (!v) throw new Error(`${n} required`); return v; };
const APP = need('E2E_APP_ORIGIN'), API = need('E2E_API'), TOKEN = need('E2E_TOKEN');
const SHOT = process.env.E2E_SCREENSHOT_DIR || tmpdir();

// Valid PNG of incompressible noise (>2 MiB => 3 chunks) built with zlib.
function crc32(buf) { return zlib.crc32(buf) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function noisePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; crypto.getRandomValues(raw.subarray(y * (w * 3 + 1) + 1, (y + 1) * (w * 3 + 1))); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}
const FILE_NAME = 'vacation-secret-photo.png';
const png = noisePng(900, 900); // ~2.4 MB
const dir = mkdtempSync(path.join(tmpdir(), 'media-browser-'));
const filePath = path.join(dir, FILE_NAME);
writeFileSync(filePath, png);
console.log(`[browser] test file ${png.length} bytes (${Math.ceil(png.length / 1048576)} chunks expected)`);

console.log('[browser] launching chromium');
const browser = await chromium.launch({ timeout: 30000 });
console.log('[browser] launched');
const context = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true, viewport: { width: 1280, height: 900 } });
await context.addInitScript(({ token, api }) => {
  localStorage.setItem('my-secrect:api-token', token);
  localStorage.setItem('my-secrect:api-base-url', api);
  localStorage.setItem('my-secrect:account-email', 'media-e2e@example.test');
}, { token: TOKEN, api: API });
const page = await context.newPage();
page.setDefaultTimeout(45000);
process.on('unhandledRejection', async (e) => { console.error('[browser] FAIL', e); try { await page.screenshot({ path: path.join(SHOT, 'media-view-failure.png') }); } catch {} process.exit(1); });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

// Record every outgoing request body, and every download-session the page opens.
const outgoing = [];
const downloads = [];
page.on('request', (r) => {
  const b = r.postDataBuffer(); if (b) outgoing.push({ url: r.url(), method: r.method(), body: b });
  if (r.url().includes('/download-session')) downloads.push(r.url());
});

await page.goto(APP, { timeout: 30000 });
console.log('[browser] app loaded');
process.on('uncaughtException', async (e) => { try { await page.screenshot({ path: path.join(SHOT, 'media-view-failure.png') }); } catch {} throw e; });
// Create a fresh local vault. Onboarding stays on the one-time recovery-key
// screen until the user acknowledges it (step 1), then shows Done (step 2).
await page.getByLabel('Master passphrase').fill('correct horse battery staple 42');
await page.getByLabel('Confirm passphrase').fill('correct horse battery staple 42');
await page.getByRole('button', { name: 'Create vault' }).click();
await page.getByLabel('I have saved my recovery key somewhere safe.').check();
await page.getByRole('button', { name: 'Done', exact: true }).click();
await page.getByRole('button', { name: 'Open vault' }).click();
await page.getByRole('button', { name: /Media gallery/ }).click();
await page.getByRole('button', { name: 'Upload encrypted file…' }).or(page.getByText('Upload encrypted file…')).first().waitFor();
console.log('[browser] media gallery open, upload control visible (api configured)');

await page.setInputFiles('[data-testid="media-upload-input"]', filePath);
await page.getByText(/Uploaded “vacation-secret-photo.png” as encrypted chunks/).waitFor({ timeout: 60000 });
const tile = page.getByLabel(`Media item ${FILE_NAME}`);
await tile.waitFor();
await tile.getByText('Manifest: verified').waitFor({ timeout: 30000 });
await tile.getByText(/3 chunks/).waitFor();
const img = tile.locator('img');
await img.waitFor({ timeout: 30000 });
const nat = await img.evaluate((el) => ({ w: el.naturalWidth, h: el.naturalHeight }));
assert.ok(nat.w > 0 && nat.w <= 256, `thumbnail decoded and downscaled (${nat.w}x${nat.h})`);
console.log(`[browser] uploaded: tile shows "Manifest: verified", 3 chunks, client-side thumbnail ${nat.w}x${nat.h}`);
await page.screenshot({ path: path.join(SHOT, 'media-view-uploaded.png') });

// Network traffic must contain no plaintext.
const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const jpegStart = Buffer.from([0xff, 0xd8, 0xff]);
const puts = outgoing.filter((o) => o.method === 'PUT');
assert.equal(puts.length, 4, 'three chunk PUTs + one thumbnail PUT');
for (const p of puts) {
  assert.equal(new URL(p.url).hostname, 's3.localhost', 'chunks go to the public S3 endpoint');
  assert.ok(!p.body.includes(magic), 'PNG magic leaked in a PUT body');
  assert.ok(!p.body.subarray(0, 3).equals(jpegStart), 'a plaintext JPEG (thumbnail) was uploaded');
  assert.ok(!png.subarray(1000, 1064).every((b, i) => p.body[1000 + i] === b), 'plaintext slice leaked');
}
const fileKeys = new Set(puts.slice(0, 3).map((p) => new URL(p.url).pathname.split('/part-')[0]));
const thumbKey = new URL(puts[3].url).pathname.split('/part-')[0];
assert.equal(fileKeys.size, 1, 'the three file parts belong to one blob');
assert.ok(!fileKeys.has(thumbKey), 'the thumbnail is a separate blob');
assert.deepEqual(puts.slice(0, 3).map((p) => p.body.length).sort((a, b) => b - a), [1048576 + 16, 1048576 + 16, png.length - 2 * 1048576 + 16]);
assert.ok(puts[3].body.length < 64 * 1024, `thumbnail blob is small (${puts[3].body.length} B)`);
for (const o of outgoing) assert.ok(!o.body.includes(Buffer.from(FILE_NAME)) && !o.body.includes(Buffer.from('image/png')) && !o.body.includes(Buffer.from('image/jpeg')), `file name / mime leaked in ${o.method} ${new URL(o.url).pathname}`);
const thumbBlobId = thumbKey.split('/blobs/')[1];
assert.ok(downloads.some((u) => u.includes(`/blobs/${thumbBlobId}/download-session`)), 'the gallery fetched the thumbnail blob');
console.log(`[browser] network check: 3 file PUTs + 1 thumbnail PUT (${puts[3].body.length} B, own blob) are ciphertext; no PNG/JPEG plaintext, file name/mime never sent in clear`);

// View: decrypted in memory, shown in the dialog, object URL revoked on close.
await tile.getByRole('button', { name: 'View' }).click();
const viewer = page.getByRole('dialog', { name: `Viewer: ${FILE_NAME}` });
const big = viewer.getByRole('img', { name: FILE_NAME });
await big.waitFor({ timeout: 60000 });
const full = await big.evaluate((el) => ({ w: el.naturalWidth, h: el.naturalHeight, src: el.src }));
assert.deepEqual([full.w, full.h], [900, 900], 'viewer shows the full decrypted image');
assert.ok(full.src.startsWith('blob:'), 'viewer uses an in-memory object URL');
await viewer.getByText('verified and decrypted on this device').waitFor();
await page.screenshot({ path: path.join(SHOT, 'media-view-viewer.png') });
await viewer.getByRole('button', { name: 'Close' }).click();
await viewer.waitFor({ state: 'hidden' });
const revoked = await page.evaluate(async (u) => { try { await fetch(u); return false; } catch { return true; } }, full.src);
assert.ok(revoked, 'object URL revoked when the viewer closed');
console.log('[browser] viewer: 900x900 decrypted image from a blob: URL; URL revoked on close');

// Download restores exact bytes.
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 60000 }),
  tile.getByRole('button', { name: 'Download decrypted' }).click(),
]);
assert.equal(download.suggestedFilename(), FILE_NAME);
const saved = path.join(dir, 'saved.png');
await download.saveAs(saved);
assert.ok(readFileSync(saved).equals(png), 'downloaded file equals original');
await page.getByText(/Decrypted and verified “vacation-secret-photo.png”/).waitFor();
console.log('[browser] download: bytes identical to original, SHA-256 verified');

// Tamper on the wire: flip one byte in chunk 2 of the response.
let tampered = false;
await page.route(/s3\.localhost.*part-00002/, async (route) => {
  const res = await route.fetch();
  const body = Buffer.from(await res.body()); body[500] ^= 1; tampered = true;
  await route.fulfill({ response: res, body });
});
let sawDownload = false;
page.once('download', () => { sawDownload = true; });
await tile.getByRole('button', { name: 'Download decrypted' }).click();
const alert = page.getByRole('alert').filter({ hasText: 'Download failed — nothing was saved' });
await alert.waitFor({ timeout: 60000 });
const msg = await alert.innerText();
assert.ok(tampered, 'route interception happened');
assert.match(msg, /chunk 2 hash mismatch/);
assert.equal(sawDownload, false, 'no file was handed to the browser after tampering');
console.log(`[browser] wire tamper rejected loudly: "${msg}"`);
await page.screenshot({ path: path.join(SHOT, 'media-view-tamper.png') });

await page.unroute(/s3\.localhost.*part-00002/);

// Connection cut mid-download: retried, then rejected loudly; nothing saved.
let cut = 0;
await page.route(/s3\.localhost.*part-00003/, (route) => { cut++; return route.abort('connectionreset'); });
let sawDownload2 = false;
page.once('download', () => { sawDownload2 = true; });
await page.getByRole('alert').filter({ hasText: 'Download failed' }).waitFor({ state: 'detached' }).catch(() => {});
await tile.getByRole('button', { name: 'Download decrypted' }).click();
const cutAlert = page.getByRole('alert').filter({ hasText: /Download failed — nothing was saved: download part 3 failed/ });
await cutAlert.waitFor({ timeout: 60000 });
assert.equal(cut, 3, 'part 3 was tried 3 times (retry with backoff) before giving up');
assert.equal(sawDownload2, false, 'nothing handed to the browser after a cut download');
console.log(`[browser] connection cut on part 3: ${cut} attempts, then "${(await cutAlert.innerText()).slice(0, 90)}…"`);
await page.unroute(/s3\.localhost.*part-00003/);

// Upload cut mid-way, then resumed: only the missing part is sent.
const FILE2 = 'scan-of-contract.png';
const png2 = noisePng(800, 800); // ~1.9 MB => 2 chunks
const file2 = path.join(dir, FILE2);
writeFileSync(file2, png2);
let blocked = 0;
await page.route(/s3\.localhost.*part-00002/, (route) => (route.request().method() === 'PUT' ? (blocked++, route.abort('connectionreset')) : route.continue()));
await page.setInputFiles('[data-testid="media-upload-input"]', file2);
const interruptedAlert = page.getByRole('alert').filter({ hasText: 'Upload interrupted — 1 of 2 parts are stored' });
await interruptedAlert.waitFor({ timeout: 60000 });
const stateKeys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('my-secrect.upload-resume.v1.')));
assert.equal(stateKeys.length, 1, 'a resume record is kept');
const record = await page.evaluate((k) => localStorage.getItem(k), stateKeys[0]);
assert.ok(!record.includes(FILE2) && !record.includes('image/png'), 'resume record holds no file name or type');
await page.unroute(/s3\.localhost.*part-00002/);
const putsBefore = outgoing.filter((o) => o.method === 'PUT').length;
await interruptedAlert.getByRole('button', { name: 'Resume upload' }).click();
await page.getByText(/Uploaded “scan-of-contract.png” as encrypted chunks\. Resumed: 1 part was already stored\./).waitFor({ timeout: 60000 });
const resumedPuts = outgoing.filter((o) => o.method === 'PUT').slice(putsBefore);
assert.deepEqual(resumedPuts.map((o) => new URL(o.url).pathname.split('/').pop()), ['part-00002', 'part-00001'], 'resume sent file part 2 only, then the thumbnail');
assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('my-secrect.upload-resume.v1.')).length), 0, 'record removed');
const tile2 = page.getByLabel(`Media item ${FILE2}`);
await tile2.getByText('Manifest: verified').waitFor({ timeout: 30000 });
await tile2.locator('img').waitFor({ timeout: 30000 });
const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), tile2.getByRole('button', { name: 'Download decrypted' }).click()]);
const saved2 = path.join(dir, 'saved2.png');
await dl2.saveAs(saved2);
assert.ok(readFileSync(saved2).equals(png2), 'resumed upload downloads to the exact original');
console.log(`[browser] upload cut on part 2 (${blocked} attempts) -> "Resume upload" sent part 2 only; bytes identical after download`);
await page.screenshot({ path: path.join(SHOT, 'media-view-resumed.png') });

// ERR_FILE_NOT_FOUND: the revocation probe above fetching the revoked blob: URL (expected).
const relevant = consoleErrors.filter((e) => !/favicon|ERR_CERT|ERR_CONNECTION_RESET|net::ERR_FAILED|ERR_FILE_NOT_FOUND/.test(e));
console.log(`[browser] console errors: ${relevant.length ? relevant.join(' | ') : 'none'}`);
await browser.close();
console.log('[browser] PASS');
