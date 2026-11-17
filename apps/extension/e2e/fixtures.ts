/**
 * Test harness: HTTPS + HTTP local servers, hostname mapping to 127.0.0.1,
 * and a copy of the REAL built extension whose manifest additionally requests
 * host permissions.
 *
 * Why the manifest copy: production relies on `activeTab`, which Chrome grants
 * only on a real toolbar-icon click. Playwright cannot click the toolbar, so
 * without it `tab.url` is hidden from the worker and every fill fails closed.
 * Only manifest.json differs; all JS (background, content, popup) is the
 * unmodified production build.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const extDir = path.resolve(here, '..');

export function buildExtension(): string {
  execFileSync('npm', ['run', 'build'], { cwd: extDir, stdio: 'pipe' });
  const tmp = mkdtempSync(path.join(tmpdir(), 'my-secrect-ext-'));
  const out = path.join(tmp, 'dist');
  cpSync(path.join(extDir, 'dist'), out, { recursive: true });
  const manifestPath = path.join(out, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['https://*/*', 'http://*/*'];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return out;
}

/**
 * A second, unrelated MV3 extension loaded next to ours. Its worker is the
 * "other extension" attacker in the isolation tests; it has no code of its own.
 */
export function writeHostileExtension(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'my-secrect-hostile-ext-'));
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, name: 'hostile-e2e', version: '1.0', background: { service_worker: 'bg.js' } }),
  );
  writeFileSync(path.join(dir, 'bg.js'), 'self.hostileE2E = true;\n');
  return dir;
}

export const LOGIN_HTML = `<!doctype html><title>login</title>
<form id="f" onsubmit="return false">
  <input id="user" name="username" type="text" autocomplete="username">
  <input id="pass" name="password" type="password" autocomplete="current-password">
</form>`;

/**
 * Hostile markup, served by path on every host. The real login fields are
 * always #user / #pass; everything with id trap-* (or in another form/frame)
 * must stay empty after a fill.
 */
function hostilePages(httpsPort: number): Record<string, string> {
  const crossFrame = `<iframe id="cross" src="https://evil.test:${httpsPort}/login" width="400" height="120"></iframe>`;
  return {
    '/honeypot': `<!doctype html><title>honeypot</title>
<form id="f" onsubmit="return false">
  <input id="trap-user" name="username" type="text" autocomplete="username" style="display:none">
  <input id="trap-offscreen" name="password" type="password" autocomplete="current-password" style="position:absolute;left:-10000px;top:0">
  <input id="trap-opacity" type="password" autocomplete="current-password" style="opacity:0">
  <span style="visibility:hidden"><input id="trap-visibility" type="password"></span>
  <input id="trap-tiny" type="password" style="width:1px;height:1px;padding:0;border:0">
  <div hidden><input id="trap-hidden-attr" type="password"></div>
  <input id="trap-readonly" type="password" readonly>
  <input id="trap-disabled" type="password" disabled>
  <input id="user" name="login" type="email">
  <input id="pass" name="pw" type="password">
</form>`,
    '/two-forms': `<!doctype html><title>two forms</title>
<form id="newsletter" onsubmit="return false"><input id="trap-news" name="email" type="email" autocomplete="email"></form>
<form id="signup" onsubmit="return false"><input id="trap-su-user" name="username" type="text" autocomplete="username"><input id="trap-su-pass" type="password" autocomplete="new-password"></form>
<form id="login" onsubmit="return false"><input id="user" name="account" type="text"><input id="pass" type="password"></form>
<form id="search" onsubmit="return false"><input id="trap-q" name="q" type="text"></form>`,
    '/formless': `<!doctype html><title>formless</title>
<div><input id="trap-search" name="query" type="text" placeholder="Search"></div>
<div id="login"><input id="user" type="email" placeholder="Email"><input id="pass" type="password"></div>
<input id="trap-after" name="username" type="text" autocomplete="username">`,
    '/hidden-only': `<!doctype html><title>hidden only</title>
<form id="f" onsubmit="return false"><input id="user" name="username" type="text"><input id="pass" type="password" style="display:none"></form>`,
    '/new-password-only': `<!doctype html><title>change password</title>
<form id="f" onsubmit="return false"><input id="user" name="username" type="text" autocomplete="username">
<input id="pass" type="password" autocomplete="new-password"><input id="trap-confirm" type="password" autocomplete="new-password"></form>`,
    '/iframe-only': `<!doctype html><title>iframe only</title><p>Sign in below.</p>${crossFrame}`,
    '/iframe-and-form': `<!doctype html><title>iframes</title>
<form id="f" onsubmit="return false"><input id="user" name="username" type="text" autocomplete="username"><input id="pass" type="password" autocomplete="current-password"></form>
${crossFrame}<iframe id="same" src="/login" width="400" height="120"></iframe>`,
  };
}

export interface Servers {
  httpsPort: number;
  httpPort: number;
  close(): Promise<void>;
}

export async function startServers(): Promise<Servers> {
  const dir = mkdtempSync(path.join(tmpdir(), 'my-secrect-cert-'));
  const key = path.join(dir, 'k.pem');
  const cert = path.join(dir, 'c.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=my-secrect-e2e'],
    { stdio: 'pipe' },
  );
  let pages: Record<string, string> = {};
  const handler: http.RequestListener = (req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(pages[new URL(req.url ?? '/', 'http://x').pathname] ?? LOGIN_HTML);
  };
  const s1 = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, handler);
  const s2 = http.createServer(handler);
  await Promise.all([
    new Promise<void>((r) => s1.listen(0, '127.0.0.1', r)),
    new Promise<void>((r) => s2.listen(0, '127.0.0.1', r)),
  ]);
  pages = hostilePages((s1.address() as AddressInfo).port);
  return {
    httpsPort: (s1.address() as AddressInfo).port,
    httpPort: (s2.address() as AddressInfo).port,
    close: () => new Promise((r) => s1.close(() => s2.close(() => r()))),
  };
}

/** Independent RFC 4226/6238 HMAC-SHA1 implementation (node:crypto, not extension code). */
import { createHmac } from 'node:crypto';
export function referenceTotp(secretAscii: string, unixSeconds: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(unixSeconds / 30)));
  const h = createHmac('sha1', Buffer.from(secretAscii, 'ascii')).update(counter).digest();
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}
