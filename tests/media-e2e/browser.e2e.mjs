// Real-browser check of the shared MediaView (web client) against the real
// stack: Chromium via Playwright, real Rails API, real MinIO through the
// public presigned endpoint. Run via `E2E_BROWSER=1 tests/media-e2e/run.sh`.
//
// Asserts, from the browser's own network traffic, that no request body
// leaving the page contains plaintext file bytes or the file name; that the
// uploaded file is listed with a verified manifest + client-side thumbnail;
// that Download restores the exact bytes; and that a byte flipped on the
// wire during download is rejected loudly with nothing saved.
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

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true, viewport: { width: 1280, height: 900 } });
await context.addInitScript(({ token, api }) => {
  localStorage.setItem('my-secrect:api-token', token);
  localStorage.setItem('my-secrect:api-base-url', api);
  localStorage.setItem('my-secrect:account-email', 'media-e2e@example.test');
}, { token: TOKEN, api: API });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

// Record every outgoing request body.
const outgoing = [];
page.on('request', (r) => { const b = r.postDataBuffer(); if (b) outgoing.push({ url: r.url(), method: r.method(), body: b }); });

await page.goto(APP);
process.on('uncaughtException', async (e) => { try { await page.screenshot({ path: path.join(SHOT, 'media-view-failure.png') }); } catch {} throw e; });
// Create a fresh vault (passphrase + recovery key onboarding).
await page.getByLabel('Master passphrase').fill('correct horse battery staple 42');
await page.getByLabel('Confirm passphrase').fill('correct horse battery staple 42');
await page.getByRole('button', { name: 'Create vault' }).click();
await page.getByRole('checkbox').check();
await page.getByRole('button', { name: 'Done' }).click();
await page.getByRole('button', { name: 'Done' }).click().catch(() => {});
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
const puts = outgoing.filter((o) => o.method === 'PUT');
assert.equal(puts.length, 3, 'three chunk PUTs');
for (const p of puts) {
  assert.equal(new URL(p.url).hostname, 's3.localhost', 'chunks go to the public S3 endpoint');
  assert.ok(!p.body.includes(magic), 'PNG magic leaked in a PUT body');
  assert.ok(!png.subarray(1000, 1064).every((b, i) => p.body[1000 + i] === b), 'plaintext slice leaked');
}
assert.deepEqual(puts.map((p) => p.body.length), [1048576 + 16, 1048576 + 16, png.length - 2 * 1048576 + 16]);
for (const o of outgoing) assert.ok(!o.body.includes(Buffer.from(FILE_NAME)) && !o.body.includes(Buffer.from('image/png')), `file name / mime leaked in ${o.method} ${new URL(o.url).pathname}`);
console.log('[browser] network check: 3 PUT bodies are ciphertext (chunk+16 B tag), no PNG magic, file name/mime never sent in clear');

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

const relevant = consoleErrors.filter((e) => !/favicon|ERR_CERT/.test(e));
console.log(`[browser] console errors: ${relevant.length ? relevant.join(' | ') : 'none'}`);
await browser.close();
console.log('[browser] PASS');
