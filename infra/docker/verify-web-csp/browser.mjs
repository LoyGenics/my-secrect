// Drives the BUILT web client as served by Caddy (strict CSP from
// infra/docker/Caddyfile) in Chromium and fails on any CSP violation.
// Run via infra/docker/verify-web-csp.sh (boots the stack, builds apps/web).
//
// Flow, all through the real UI against the real API + MinIO:
//   sign-up email code (read from the test mail catcher, MAILPIT_URL) ->
//   passkey account registration (CDP virtual authenticator; the API verifies
//   the attestation) -> vault creation (libsodium Argon2id in WebAssembly) ->
//   media upload (client-side encryption, presigned PUTs to s3.<site>) ->
//   thumbnail (decrypted, blob: URL) -> decrypted download (blob: URL) ->
//   Security Center (API reads) -> lock + reload + unlock (fresh page load).
// Violations are captured two ways: `securitypolicyviolation` events
// (init script) and Chromium's console "Refused to ..." messages.
// A final negative control injects an inline <script>, which MUST be
// blocked and reported, proving the policy is enforced and the detector works.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const APP = process.env.CSP_APP_ORIGIN;
if (!APP) throw new Error('CSP_APP_ORIGIN required (run via verify-web-csp.sh)');
const SHOTS = process.env.CSP_SCREENSHOT_DIR || mkdtempSync(path.join(tmpdir(), 'a16-csp-'));
const PASS = `csp check ${Math.random().toString(36).slice(2)} passphrase`;
const log = (m) => console.log(`[browser] ${m}`);
const MAILPIT = process.env.MAILPIT_URL;
if (!MAILPIT) throw new Error('MAILPIT_URL required (run via verify-web-csp.sh)');

// Sign-up codes mailed to `email`, oldest first (Mailpit's HTTP API lists newest first).
async function mailedCodes(email) {
  const list = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json();
  const codes = [];
  for (const m of [...(list.messages ?? [])].reverse()) {
    const msg = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
    const hit = /verification code is (\d{6})/.exec(String(msg.Text ?? ''));
    if (hit) codes.push(hit[1]);
  }
  return codes;
}
async function waitForCode(email, seen) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const codes = await mailedCodes(email);
    if (codes.length > seen) return codes[codes.length - 1];
    if (Date.now() > deadline) throw new Error('no sign-up code reached the test mailbox');
    await new Promise((r) => setTimeout(r, 300));
  }
}

// Small valid PNG of noise (>1 MiB -> 2 encrypted chunks).
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function noisePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) crypto.getRandomValues(raw.subarray(y * (w * 3 + 1) + 1, (y + 1) * (w * 3 + 1)));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}
const FILE_NAME = 'csp-check-photo.png';
const png = noisePng(700, 700);
const dir = mkdtempSync(path.join(tmpdir(), 'a16-csp-file-'));
writeFileSync(path.join(dir, FILE_NAME), png);

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true, viewport: { width: 1280, height: 900 } });
await context.addInitScript(([key, api]) => {
  try { if (localStorage.getItem(key) === null) localStorage.setItem(key, api); } catch { /* ignore */ }
  document.addEventListener('securitypolicyviolation', (e) => {
    const v = { directive: e.effectiveDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber, disposition: e.disposition };
    try { const k = '__csp_violations'; const all = JSON.parse(sessionStorage.getItem(k) || '[]'); all.push(v); sessionStorage.setItem(k, JSON.stringify(all)); } catch { /* ignore */ }
  });
}, ['my-secrect:api-base-url', `${APP}/api`]);
const page = await context.newPage();
page.setDefaultTimeout(45_000);

const consoleCsp = [];
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  const t = m.text();
  if (/Content Security Policy|Refused to/i.test(t)) consoleCsp.push(t);
  else if (m.type() === 'error') consoleErrors.push(t);
});
page.on('pageerror', (e) => pageErrors.push(String(e)));
const violations = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('__csp_violations') || '[]'));

// Virtual authenticator (CTAP2, resident key, user verification).
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

try {
  const res = await page.goto(APP);
  const h = res.headers();
  assert.ok(h['content-security-policy'], 'document has an enforced Content-Security-Policy header');
  assert.equal(h['content-security-policy-report-only'], undefined, 'policy is enforced, not report-only');
  assert.match(h['content-security-policy'], /script-src 'self' 'wasm-unsafe-eval' https:\/\/accounts\.google\.com\/gsi\/client https:\/\/appleid\.cdn-apple\.com\/appleauth\/static\/jsapi\/appleid\/1\/;/);
  assert.doesNotMatch(h['content-security-policy'], /unsafe-inline|'unsafe-eval'/);
  log(`app loaded from Caddy; CSP: ${h['content-security-policy']}`);

  // Sign-up: email code from the test mailbox, then a passkey (the Rails API verifies the attestation).
  const email = `csp-${Date.now().toString(36)}@example.test`;
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Account email').fill(email);
  const seen = (await mailedCodes(email)).length;
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await page.getByRole('heading', { name: 'Check your email' }).waitFor();
  await page.getByLabel('Verification code').fill(await waitForCode(email, seen));
  await page.getByRole('button', { name: 'Create account with passkey' }).click();
  await page.getByRole('heading', { name: 'my-secrect' }).waitFor();
  log('account registered: emailed code entered, passkey created (WebAuthn ceremony in the page)');

  // Vault onboarding: Argon2id in libsodium's WebAssembly.
  await page.getByLabel('Master passphrase', { exact: true }).fill(PASS);
  await page.getByLabel('Confirm passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Create vault' }).click();
  await page.locator('div.font-mono').first().waitFor();
  await page.getByLabel('I have saved my recovery key somewhere safe.').check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Open vault' }).click();
  await page.getByRole('button', { name: /Lock vault/ }).waitFor();
  log('vault created and opened (libsodium WebAssembly under wasm-unsafe-eval)');

  // Media: encrypt in the tab, presigned PUTs to the public S3 endpoint.
  await page.getByRole('button', { name: /Media gallery/ }).click();
  await page.setInputFiles('[data-testid="media-upload-input"]', path.join(dir, FILE_NAME));
  await page.getByText(/Uploaded “csp-check-photo.png” as encrypted chunks/).waitFor({ timeout: 60_000 });
  const tile = page.getByLabel(`Media item ${FILE_NAME}`);
  await tile.getByText('Manifest: verified').waitFor({ timeout: 30_000 });
  const img = tile.locator('img');
  await img.waitFor({ timeout: 30_000 });
  const nat = await img.evaluate((el) => ({ w: el.naturalWidth, src: el.getAttribute('src') || '' }));
  assert.ok(nat.w > 0 && nat.src.startsWith('blob:'), 'decrypted thumbnail rendered from a blob: URL');
  log(`media uploaded to s3 endpoint (connect-src), thumbnail decrypted and shown from blob: (${nat.w}px wide)`);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), tile.getByRole('button', { name: 'Download decrypted' }).click()]);
  const saved = path.join(dir, 'saved.png');
  await download.saveAs(saved);
  assert.ok(readFileSync(saved).equals(png), 'downloaded bytes equal the original');
  log('decrypted download via blob: URL, bytes identical');
  await page.screenshot({ path: path.join(SHOTS, 'csp-media.png') });

  // Security Center: authenticated API reads.
  await page.getByRole('button', { name: /Security Center/ }).first().click();
  await page.getByRole('heading', { name: 'Security Center', level: 2 }).waitFor();
  await page.getByText('Loading…').waitFor({ state: 'detached' }).catch(() => {});
  log('Security Center loaded (API reads)');

  // Lock, full reload, unlock again (fresh document under the same policy).
  await page.getByRole('button', { name: /Lock vault/ }).click();
  await page.reload();
  await page.getByText(/Your vault is locked/).waitFor();
  await page.getByLabel('Master passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByRole('button', { name: /Lock vault/ }).waitFor();
  log('lock -> reload -> unlock OK');

  // Secrets this session produced, for the runner's log scan (never printed).
  if (process.env.CSP_NEEDLES) {
    const token = await page.evaluate(() => localStorage.getItem('my-secrect:api-token'));
    appendFileSync(process.env.CSP_NEEDLES, [PASS, token].filter(Boolean).join('\n') + '\n');
  }

  const appViolations = await violations();
  console.log(`[browser] CSP violations during the app flow: events=${appViolations.length}, console=${consoleCsp.length}`);
  for (const v of appViolations) console.log(`[browser]   event: ${JSON.stringify(v)}`);
  for (const c of consoleCsp) console.log(`[browser]   console: ${c}`);
  if (consoleErrors.length) console.log(`[browser] other console errors (not CSP): ${consoleErrors.join(' | ')}`);
  if (pageErrors.length) console.log(`[browser] uncaught page errors: ${pageErrors.join(' | ')}`);
  assert.equal(appViolations.length, 0, 'no securitypolicyviolation events');
  assert.equal(consoleCsp.length, 0, 'no CSP messages in the console');
  assert.equal(pageErrors.length, 0, 'no uncaught page errors');

  // Negative control: an inline script must be blocked AND reported.
  const ran = await page.evaluate(async () => {
    const s = document.createElement('script');
    s.textContent = 'window.__inlineRan = true;';
    document.head.appendChild(s);
    await new Promise((r) => setTimeout(r, 300));
    return window.__inlineRan === true;
  });
  await page.waitForTimeout(300);
  const after = await violations();
  assert.equal(ran, false, 'inline script was blocked');
  assert.ok(after.some((v) => v.directive === 'script-src-elem' || v.directive === 'script-src'), 'the blocked inline script was reported');
  assert.ok(consoleCsp.length >= 1, 'Chromium logged the blocked inline script');
  log(`negative control: injected inline <script> blocked and reported (${after.length} event, ${consoleCsp.length} console line)`);
  log('PASS: built web app ran the full flow under the strict CSP with 0 violations');
} catch (e) {
  try { await page.screenshot({ path: path.join(SHOTS, 'csp-failure.png') }); log(`failure screenshot: ${path.join(SHOTS, 'csp-failure.png')}`); } catch { /* ignore */ }
  console.error(`[browser] FAIL: ${e?.stack ?? e}`);
  if (consoleCsp.length) console.error(`[browser] CSP console: ${consoleCsp.join(' | ')}`);
  if (consoleErrors.length) console.error(`[browser] console errors: ${consoleErrors.join(' | ')}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
