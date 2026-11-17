// Firefox MV3 diagnostic (NOT a test; prints what happens). Loads the built
// extension into a real Firefox over WebDriver BiDi (webExtension.install)
// and exercises it through the real popup/options pages.
//
//   npm --workspace apps/extension run build
//   node apps/extension/e2e/firefox-probe.mjs A   # production dist as built (+ gecko id)
//   node apps/extension/e2e/firefox-probe.mjs B   # + background.scripts (Firefox has no MV3 service_worker)
//
// Env: FIREFOX (default: macOS Firefox.app), FF_BIDI_PORT (default 5341).
// The gecko id is added only to pin the moz-extension UUID; phase B also adds
// https host permissions because automation cannot click the toolbar (same as
// the Chromium harness in fixtures.ts). Results as of Firefox 151: README.md.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const phase = process.argv[2] === 'B' ? 'B' : 'A';
const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIREFOX = process.env.FIREFOX ?? '/Applications/Firefox.app/Contents/MacOS/firefox';
const PORT = Number(process.env.FF_BIDI_PORT ?? 5341);
const UUID = '6b1f8f3e-4c1a-4f8e-9a51-2d1c0e7b9a01';
const ADDON_ID = 'my-secrect-probe@example.test';
const PASS = 'firefox-probe-passphrase-fixture';

const work = mkdtempSync(path.join(tmpdir(), 'my-secrect-ff-'));
const ext = path.join(work, 'ext');
cpSync(path.join(extDir, 'dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
manifest.browser_specific_settings = { gecko: { id: ADDON_ID } };
if (phase === 'B') {
  manifest.background = { scripts: ['background.js'], type: 'module' };
  manifest.host_permissions = ['https://*/*'];
}
writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));

const key = path.join(work, 'k.pem');
const cert = path.join(work, 'c.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'pipe' });
const srv = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_q, r) => {
  r.setHeader('content-type', 'text/html');
  r.end('<!doctype html><form><input id="user" autocomplete="username"><input id="pass" type="password" autocomplete="current-password"></form>');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const pagePort = srv.address().port;

const profile = path.join(work, 'profile');
mkdirSync(profile);
writeFileSync(path.join(profile, 'user.js'), [
  `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [ADDON_ID]: UUID }))});`,
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
].join('\n'));
const ff = spawn(FIREFOX, ['--headless', '--no-remote', '--profile', profile, `--remote-debugging-port=${PORT}`], { stdio: 'ignore' });

let ws;
for (let i = 0; i < 60 && !ws; i++) {
  try {
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/session`);
    await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
    ws = sock;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!ws) throw new Error('Firefox did not open a WebDriver BiDi endpoint');
let nextId = 1;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });

const out = { phase };
try {
  out.firefox = (await send('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } })).result?.capabilities?.browserVersion;
  const install = await send('webExtension.install', { extensionData: { type: 'path', path: ext } });
  out.install = install.error ? `${install.error}: ${install.message}` : 'installed';
  if (!install.error) {
    const context = (await send('browsingContext.getTree', {})).result.contexts[0].context;
    const evalIn = async (ctx, expression) => {
      const r = await send('script.evaluate', { expression, target: { context: ctx }, awaitPromise: true, resultOwnership: 'none' });
      return r.result?.result?.value ?? r.result?.exceptionDetails?.text ?? JSON.stringify(r.error ?? r);
    };
    const msg = (m) => evalIn(context, `chrome.runtime.sendMessage(${JSON.stringify(m)}).then((r) => JSON.stringify(r), (e) => 'ERR ' + e.message)`);
    const base = `moz-extension://${UUID}`;
    await send('browsingContext.navigate', { context, url: `${base}/popup/index.html`, wait: 'complete' });
    await new Promise((r) => setTimeout(r, 1500));
    out.popup = (await evalIn(context, 'document.body.innerText')).split('\n')[0];
    out.getStatus = await msg({ type: 'getStatus' });
    out.createVault = (await msg({ type: 'createVault', passphrase: PASS })).replace(/"recoveryKey":"[^"]+"/, '"recoveryKey":"<redacted>"');
    out.lock = await msg({ type: 'lock' });
    out.unlock = await msg({ type: 'unlock', passphrase: PASS });
    out.wrongRecoveryKey = await msg({ type: 'unlockRecovery', recoveryKey: 'A'.repeat(43) });
    out.unlockAgain = await msg({ type: 'unlock', passphrase: PASS }); // a failed unlock clears memory (locks)
    const item = { id: 'ff-1', type: 'login', schema_version: 1, title: 'Local', fields: { username: 'ff', password: 'pw-ff-fixture', url: `https://localhost:${pagePort}/` }, tags: [], relations: [], attachments: [], created_at: 'x', updated_at: 'x' };
    out.saveLogin = await msg({ type: 'saveLogin', item });
    out.plaintextInStorage = await evalIn(context, `chrome.storage.local.get(null).then((v) => JSON.stringify(v).includes('pw-ff-fixture'))`);
    await send('browsingContext.navigate', { context, url: `${base}/options/index.html`, wait: 'complete' });
    await new Promise((r) => setTimeout(r, 1000));
    out.options = (await evalIn(context, 'document.body.innerText')).split('\n')[0];
    const tab = (await send('browsingContext.create', { type: 'tab' })).result.context;
    await send('browsingContext.navigate', { context: tab, url: `https://localhost:${pagePort}/login`, wait: 'complete' });
    await send('browsingContext.activate', { context: tab });
    out.fill = await msg({ type: 'fill', id: 'ff-1' });
    out.pagePasswordAfterFill = await evalIn(tab, `document.getElementById('pass').value`);
  }
} catch (e) {
  out.error = String(e);
}
console.log(JSON.stringify(out, null, 2));
await send('session.end', {}).catch(() => undefined);
ff.kill('SIGTERM');
srv.close();
process.exit(0);
