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
 * Test pages, served by path on every host. The real login fields are
 * always #user / #pass; everything with id trap-* (or in another form/frame)
 * must stay empty after a fill. /signin really submits (POST, navigates).
 */
function testPages(httpsPort: number): Record<string, string> {
  const crossFrame = `<iframe id="cross" src="https://evil.test:${httpsPort}/login" width="400" height="120"></iframe>`;
  return {
    '/signin': `<!doctype html><title>sign in</title>
<form id="f" method="post" action="/welcome">
  <input id="user" name="username" type="text" autocomplete="username">
  <input id="pass" name="password" type="password" autocomplete="current-password">
  <button id="go" type="submit">Sign in</button>
</form>
<form id="other" method="post" action="/welcome"><input id="trap-q" name="q" type="text"><button id="go-other" type="submit">Search</button></form>`,
    '/welcome': '<!doctype html><title>welcome</title><p id="welcome">Signed in.</p>',
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
  pages = testPages((s1.address() as AddressInfo).port);
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

/**
 * Mock account API (the subset of apps/api the extension calls), on
 * http://127.0.0.1:<port>/api. It checks the device proof for real
 * (Ed25519 over the spec message, node:crypto), so a session here means the
 * extension produced a valid proof. Fixture values only, no real secrets:
 * the email code is always EMAIL_CODE and the MFA code MFA_CODE; addresses
 * starting with "mfa" get the MFA step.
 */
import { createPublicKey, randomBytes, verify as edVerify } from 'node:crypto';

export const EMAIL_CODE = '123456';
export const MFA_CODE = '654321';

export interface MockApi {
  base: string;
  /** Every request: method, path, raw body. */
  requests: { method: string; path: string; body: string }[];
  /** Live session tokens. */
  sessions: Map<string, { id: string; email: string; deviceId: string | null }>;
  revoked: string[];
  devices: Map<string, string>; // device id -> base64url public key
  google: boolean;
  /** Invalidate every session server-side (the next authenticated call gets 401). */
  expireAll(): void;
  close(): Promise<void>;
}

function deviceMessage(purpose: string, payload: Record<string, string>): Buffer {
  const body = Object.keys(payload).sort().map((k) => `"${k}":"${payload[k]}"`).join(',');
  return Buffer.from(`my-secrect/device/v1/${purpose}\n{${body}}`);
}

function edValid(publicKeyB64u: string, message: Buffer, signatureB64u: string): boolean {
  try {
    const raw = Buffer.from(publicKeyB64u, 'base64url');
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
    return edVerify(null, message, key, Buffer.from(signatureB64u, 'base64url'));
  } catch {
    return false;
  }
}

export async function startMockApi(): Promise<MockApi> {
  const tickets = new Map<string, string>(); // ticket -> email
  const mfaTokens = new Map<string, { email: string; deviceId: string | null }>();
  const rand = () => randomBytes(16).toString('hex');
  const api: MockApi = {
    base: '',
    requests: [],
    sessions: new Map(),
    revoked: [],
    devices: new Map(),
    google: false,
    expireAll: () => api.sessions.clear(),
    close: async () => undefined,
  };

  /** Checks a device proof over `challenge`; returns the device id, null without proof, or 'bad'. */
  const proveDevice = (device: Record<string, string> | undefined, challenge: string): string | null | 'bad' => {
    if (!device) return null;
    if (device.public_key) {
      if (!edValid(device.public_key, deviceMessage('enroll', { challenge, public_key: device.public_key }), device.signature)) return 'bad';
      const id = `dev-${rand()}`;
      api.devices.set(id, device.public_key);
      return id;
    }
    const pk = api.devices.get(device.id);
    if (!pk || !edValid(pk, deviceMessage('session-bind', { challenge, device_id: device.id }), device.signature)) return 'bad';
    return device.id;
  };
  const session = (email: string, deviceId: string | null) => {
    const token = `sess_${rand()}${rand()}`;
    api.sessions.set(token, { id: `s-${rand()}`, email, deviceId });
    return { token, user_id: `u-${email}`, device_id: deviceId, expires_in: 3600, account_created: false };
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/api/, '');
      api.requests.push({ method: req.method ?? '', path, body: raw });
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, any>;
      const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const send = (status: number, json?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(json === undefined ? '' : JSON.stringify(json));
      };
      const key = `${req.method} ${path}`;
      if (key === 'GET /v1/auth/providers') return send(200, { google: api.google ? { web_client_id: null, ios_client_id: null, android_client_id: null, extension_client_id: 'e2e-client.apps.googleusercontent.com' } : null, apple: null });
      if (key === 'POST /v1/auth/email/request') return /^[^@\s]+@[^@\s]+$/.test(body.email ?? '') ? send(202, { status: 'sent' }) : send(422, { error: 'invalid_email' });
      if (key === 'POST /v1/auth/email/verify') {
        if (body.code !== EMAIL_CODE) return send(401, { error: 'verification_failed' });
        const ticket = rand();
        tickets.set(ticket, body.email);
        return send(200, { registration_ticket: ticket, expires_in: 600 });
      }
      if (key === 'POST /v1/auth/email/session') {
        if (tickets.get(body.registration_ticket) !== body.email) return send(401, { error: 'verification_failed' });
        const deviceId = proveDevice(body.device, body.registration_ticket);
        if (deviceId === 'bad') return send(401, { error: 'device_verification_failed' });
        tickets.delete(body.registration_ticket);
        if (String(body.email).startsWith('mfa')) {
          const mfaToken = rand();
          mfaTokens.set(mfaToken, { email: body.email, deviceId });
          return send(200, { mfa_required: true, mfa_token: mfaToken, user_id: `u-${body.email}` });
        }
        return send(200, session(body.email, deviceId));
      }
      if (key === 'POST /v1/auth/mfa/verify') {
        const pending = mfaTokens.get(body.mfa_token);
        mfaTokens.delete(body.mfa_token); // single-use whatever the code
        if (!pending || body.code !== MFA_CODE) return send(401, { error: 'verification_failed' });
        return send(200, session(pending.email, pending.deviceId));
      }
      const live = auth ? api.sessions.get(auth) : undefined;
      if (key === 'GET /v1/auth/sessions') {
        if (!live) return send(401, { error: 'unauthorized' });
        return send(200, { sessions: [{ id: live.id, current: true }] });
      }
      if (req.method === 'DELETE' && path.startsWith('/v1/auth/sessions/')) {
        if (!live || path !== `/v1/auth/sessions/${live.id}`) return send(401, { error: 'unauthorized' });
        api.sessions.delete(auth!);
        api.revoked.push(live.id);
        return send(204);
      }
      return send(404, { error: 'not_found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  api.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  api.close = () => new Promise((r) => server.close(() => r()));
  return api;
}

type Bg = (msg: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Sign in with email + code through the background messages (the popup's path, minus the UI). */
export async function signInViaMessages(bg: Bg, apiBase: string, email = 'e2e@example.test'): Promise<void> {
  for (const msg of [
    { type: 'setApiBaseUrl', url: apiBase },
    { type: 'requestEmailCode', email },
    { type: 'verifyEmailCode', code: EMAIL_CODE },
  ]) {
    const res = await bg(msg);
    if (res.ok !== true) throw new Error(`sign-in step ${msg.type} failed: ${JSON.stringify(res)}`);
  }
  const acc = await bg({ type: 'getAccount' });
  if ((acc.account as { step?: string } | undefined)?.step !== 'signed-in') throw new Error(`not signed in: ${JSON.stringify(acc)}`);
}
