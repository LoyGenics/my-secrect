/**
 * Acceptance H — device revocation: future access rejected, honest offline limits.
 *
 * Real stack: Rails API + Postgres (lib/stack.ts), the web app in real
 * Chromium (device B), and a real Node client (device A: desktop vault module
 * + SyncEngine + SDK, tests/sync-e2e/client-worker.ts). Device B has its OWN
 * passkey, added to the account through the real step-up + add-passkey API.
 *
 * What a user expects from "Revoke device B":
 *   1. B's existing session stops working on every server route.       (passes)
 *   2. B's browser notices on its next server call and says so:
 *      account call (Security Center)                                    (passes)
 *      sync pull                                               (DEFECT-H3, todo)
 *   3. Data B already holds stays on B, encrypted (no remote wipe), but
 *      with mandatory sign-in (specs/account-sign-in.md) there is no
 *      local-only way to open it without an account session.         (passes)
 *   4. Each session is bound to its own device key; only B is cut off,
 *      A keeps working. (passes on main; was DEFECT-H1 on integrate/wave0)
 *   5. B cannot simply sign in again with its passkey and pull
 *      items created after the revocation. (passes; was DEFECT-H2: the
 *      passkey that enrolled B now needs re-approval from a still-trusted
 *      device before it can enrol a new device — specs/device-identity.md §6.3)
 *   6. Revoking B's device AND removing B's passkey keeps B out.         (passes)
 * DEFECT tests are written as the correct expectation and marked todo;
 * ACCEPTANCE_STRICT=1 turns them into failures.
 *
 * Run: npx tsx --test --test-concurrency=1 tests/acceptance/device-revocation.e2e.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { logDir, startApi, startWeb, type RunningApi } from './lib/stack.ts';
import { apiStatus, freshDevice, restoreViaUi, signInViaUi, storedToken, tokenDigest, unlockViaUi, LS_VAULT_KEYS, LS_VAULT_ROWS } from './lib/browser.ts';
import { AccountSession } from './lib/account.ts';
import { SoftwareAuthenticator } from '../sync-e2e/software-authenticator.ts';
import { Client } from '../sync-e2e/helpers.ts';

const API_PORT = Number(process.env.ACCEPT_H_API_PORT ?? 3253);
const WEB_PORT = Number(process.env.ACCEPT_H_WEB_PORT ?? 5365);
const WEB = `http://localhost:${WEB_PORT}`;
const DB = process.env.ACCEPT_H_DB ?? 'vault_h_a15_e2eauth';
const PASS = 'acceptance H passphrase 1';
const EMAIL = `h-revoke-${Date.now()}@example.test`;
const defect = (id: string) => (process.env.ACCEPTANCE_STRICT ? undefined : id);
const id = (s: string) => `item_${s.padEnd(32, '0')}`;
const ITEMS = { one: { id: id('h01'), title: 'H-BEFORE-REVOKE-1' }, two: { id: id('h02'), title: 'H-BEFORE-REVOKE-2' }, after: { id: id('h03'), title: 'H-CREATED-AFTER-REVOKE' } };

let api: RunningApi;
let web: { stop(): Promise<void> };
let browser: Browser;
let A: Client;
let PA: SoftwareAuthenticator;
let PB: SoftwareAuthenticator;
let backup = '';
let B: { ctx: BrowserContext; page: Page };
let bToken = '';
let aToken = '';
const dir = mkdtempSync(path.join(tmpdir(), 'accept-h-'));

const sessionDevice = (raw: string) => api.psql(`SELECT device_id FROM sessions WHERE token_digest='${tokenDigest(raw)}'`);
const aStoredToken = async () => (await A.call<Record<string, string>>('rawStorage'))['sync-e2e.token'];

before(async () => {
  api = await startApi({ port: API_PORT, db: DB, webOrigin: WEB });
  web = await startWeb(WEB_PORT);
  // Full Chromium, not chrome-headless-shell: the shell turns on macOS Secure Input.
  browser = await chromium.launch({ channel: 'chromium' });
  A = new Client('A', path.join(dir, 'a.json')).start({ API_BASE: api.apiBase, WEBAUTHN_ORIGIN: WEB, WEBAUTHN_RP_ID: 'localhost', MAIL_DIR: api.mailDir });
});
after(async () => {
  await B?.ctx.close().catch(() => undefined);
  await browser?.close();
  await A?.kill();
  await web?.stop();
  await api?.stop();
});

test('setup: device A registers, creates the vault and syncs; the account gets a second passkey for device B (real step-up + add-passkey)', async () => {
  PA = SoftwareAuthenticator.create(WEB, 'localhost');
  PB = SoftwareAuthenticator.create(WEB, 'localhost');
  assert.equal((await A.call('register', { email: EMAIL, authenticator: PA.exportCredential() })).signedIn, true);
  await A.call('createVault', { passphrase: PASS });
  backup = await A.call<string>('exportBackup');
  assert.equal(await A.call('unlock', { passphrase: PASS }), true);
  await A.call('startSync');
  for (const it of [ITEMS.one, ITEMS.two]) await A.call('createItem', { id: it.id, title: it.title, fields: { username: 'h', password: `${it.title}-pw` } });
  assert.equal((await A.call('syncNow')).state, 'idle');
  aToken = await aStoredToken();

  const admin = await AccountSession.signIn(api.apiBase, EMAIL, PA);
  await admin.addPasskey(PA, PB);
  assert.equal(api.psql(`SELECT count(*) FROM authenticators WHERE revoked_at IS NULL`), '2');
});

test('device B (real Chromium) signs in with its own passkey, restores the backup, unlocks and pulls A\'s items', async () => {
  const d = await freshDevice(browser, api.apiBase);
  B = d;
  await d.auth.importSoftware(PB.exportCredential());
  await d.page.goto(WEB);
  await signInViaUi(d.page, EMAIL);
  await d.page.getByText('Create your local vault').waitFor();
  await restoreViaUi(d.page, backup, { passphrase: PASS });
  await unlockViaUi(d.page, PASS);
  for (const it of [ITEMS.one, ITEMS.two]) await d.page.getByText(it.title).first().waitFor({ timeout: 30_000 });
  await d.page.getByTestId('sync-status').and(d.page.locator('[data-state="idle"]')).waitFor();
  bToken = (await storedToken(d.page))!;
  assert.match(bToken, /^sess_[0-9a-f]{64}$/);
  assert.equal(await apiStatus(api.apiBase, bToken, 'GET', '/v1/vaults'), 200);
});

// Was DEFECT-H1 on integrate/wave0 (every sign-in bound to user.devices.active.first);
// fixed on main by the Ed25519 device proof (specs/device-identity.md).
test('B\'s session is bound to a device record of its own (its device key), not to A\'s device', () => {
  const a = sessionDevice(aToken);
  const b = sessionDevice(bToken);
  assert.ok(a && b, 'both sessions are device-bound');
  assert.notEqual(b, a, 'A and B sessions point at the same device row');
});

let revokedDeviceId = '';
test('revoking B\'s device: B\'s token is refused on every route (sync pull/push, vaults, devices, sessions, blobs)', async () => {
  revokedDeviceId = sessionDevice(bToken);
  assert.ok(revokedDeviceId, 'B\'s session has a device');
  const admin = await AccountSession.signIn(api.apiBase, EMAIL, PA);
  await admin.client().revokeDevice(revokedDeviceId);
  assert.ok(api.psql(`SELECT revoked_at FROM devices WHERE id='${revokedDeviceId}'`), 'device marked revoked');
  const vaultId = api.psql('SELECT id FROM vaults LIMIT 1');
  const routes: Array<[string, string, unknown?]> = [
    ['GET', '/v1/vaults'],
    ['GET', `/v1/vaults/${vaultId}/sync`],
    ['POST', `/v1/vaults/${vaultId}/sync/push`, { item_id: '00000000-0000-4000-8000-000000000001', base_revision: 0, operation: 'upsert', encrypted_payload: 'AAAA', encrypted_item_key: 'AAAA', encryption_version: 1 }],
    ['GET', `/v1/vaults/${vaultId}/key-envelopes`],
    ['GET', '/v1/devices'],
    ['GET', '/v1/auth/sessions'],
    ['POST', '/v1/blobs/upload-session', { vault_id: vaultId, blob_id: crypto.randomUUID(), part_count: 1, ciphertext_size: 32, encrypted_manifest: 'AAAA' }],
  ];
  for (const [method, route, body] of routes) {
    assert.equal(await apiStatus(api.apiBase, bToken, method, route, body), 401, `${method} ${route} with the revoked device's token`);
  }
  assert.equal(api.psql(`SELECT count(*) FROM key_envelopes WHERE recipient_id='${revokedDeviceId}'`), '0');
});

test('B\'s next SYNC call after the revocation sends it back to sign-in', async () => {
  const p = B.page;
  await p.getByRole('button', { name: 'Sync now' }).click();
  const outcome = await Promise.race([
    p.getByRole('heading', { name: 'Sign in to your account' }).waitFor({ timeout: 15_000 }).then(() => 'sign-in'),
    p.getByTestId('sync-error').waitFor({ timeout: 15_000 }).then(async () => `sync error: ${await p.getByTestId('sync-error').textContent()}`),
  ]);
  assert.equal(outcome, 'sign-in');
});

test('B\'s browser returns to sign-in on its next account call ("session expired"); the encrypted vault stays on the device', async () => {
  const p = B.page;
  if (!(await p.getByRole('heading', { name: 'Sign in to your account' }).isVisible())) {
    await p.getByRole('button', { name: /Security Center/ }).first().click();
  }
  await p.getByRole('heading', { name: 'Sign in to your account' }).waitFor({ timeout: 30_000 });
  await p.getByText('Your session expired').waitFor();
  assert.equal(await storedToken(p), null, 'token cleared');
  const offline = await p.evaluate(([k, r]) => ({ keys: localStorage.getItem(k), rows: localStorage.getItem(r) }), [LS_VAULT_KEYS, LS_VAULT_ROWS]);
  assert.ok(offline.keys && offline.rows, 'revocation is not a remote wipe: the encrypted vault is still on B');
});

test('no local-only escape after the session-expired bounce: no "Continue without signing in", the vault stays closed', async () => {
  const p = B.page;
  await p.getByRole('heading', { name: 'Sign in to your account' }).waitFor();
  assert.equal(await p.getByRole('button', { name: /Continue without signing in/ }).count(), 0, 'the gate offers a local-only way past sign-in');
  await p.waitForTimeout(3_000); // give a remounting shell time to appear if it were reachable
  await p.screenshot({ path: path.join(logDir, 'h-b-no-local-only.png') });
  assert.equal(await p.getByRole('heading', { name: 'Sign in to your account' }).isVisible(), true, 'left the sign-in gate without a session');
  assert.equal(await p.getByRole('button', { name: /Lock vault/ }).count(), 0, 'local vault shell reachable without a session');
});

test('honest offline limit: after a reload the revoked browser still holds its encrypted vault but cannot open it with no session', async () => {
  const p = B.page;
  await p.reload();
  await p.getByRole('heading', { name: 'Sign in to your account' }).waitFor();
  assert.equal(await p.getByRole('button', { name: /Continue without signing in/ }).count(), 0, 'the gate offers a local-only way past sign-in');
  assert.equal(await p.getByText('Your vault is locked').count(), 0, 'lock screen reachable without a session');
  for (const it of [ITEMS.one, ITEMS.two]) assert.equal(await p.getByText(it.title).count(), 0, `"${it.title}" readable without a session`);
  const offline = await p.evaluate(([k, r]) => ({ keys: localStorage.getItem(k), rows: localStorage.getItem(r) }), [LS_VAULT_KEYS, LS_VAULT_ROWS]);
  assert.ok(offline.keys && offline.rows, 'the encrypted vault is still on B after a reload');
  assert.equal(await storedToken(p), null, 'no session');
});

test('only B is cut off: A\'s session keeps working (and syncing) after B\'s device is revoked', async () => {
  assert.equal(await apiStatus(api.apiBase, aToken, 'GET', '/v1/vaults'), 200);
  // A creates an item after the revocation; B must never be able to read it.
  await A.call('createItem', { id: ITEMS.after.id, title: ITEMS.after.title, fields: { password: 'after-revoke' } });
  assert.equal((await A.call('syncNow')).state, 'idle');
});

let reEnrolledDevice = '';
// Was DEFECT-H2: the revoked browser signed in again with the same passkey and
// enrolled a fresh device key. Fixed by durable revocation (§6.3): B's passkey
// enrolled the revoked device, so it may only bind an ACTIVE device until it is
// re-approved from a still-trusted device; the fresh enrolment is refused.
test('the revoked device cannot sign in again with its passkey and read items created after the revocation', async () => {

  const p = B.page;
  await p.evaluate(() => localStorage.removeItem('my-secrect:api-token'));
  await p.reload();
  await p.getByRole('heading', { name: 'Sign in to your account' }).waitFor();
  await signInViaUi(p, EMAIL);
  const outcome = await Promise.race([
    p.getByText(/Sign-in failed|not allowed|revoked/i).first().waitFor({ timeout: 20_000 }).then(() => 'refused' as const),
    p.getByText('Your vault is locked').waitFor({ timeout: 20_000 }).then(() => 'signed-in' as const),
  ]).catch(() => 'unknown' as const);
  if (outcome === 'signed-in') {
    const token = (await storedToken(p))!;
    reEnrolledDevice = sessionDevice(token);
    const status = await apiStatus(api.apiBase, token, 'GET', '/v1/vaults');
    await unlockViaUi(p, PASS);
    const sawNewItem = await p.getByText(ITEMS.after.title).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
    const how = reEnrolledDevice && reEnrolledDevice !== revokedDeviceId ? `on a newly enrolled device ${reEnrolledDevice}` : `on device ${reEnrolledDevice || '(none)'}`;
    assert.fail(`revoked device B signed in again ${how} (GET /v1/vaults -> ${status}) and ${sawNewItem ? 'pulled' : 'could pull'} "${ITEMS.after.title}", created after the revocation`);
  }
  assert.equal(outcome, 'refused');
});

test('complete cut-off: revoking B\'s device AND removing B\'s passkey keeps B out for good', async () => {
  const admin = await AccountSession.signIn(api.apiBase, EMAIL, PA);
  await admin.stepUp(PA);
  const { authenticators } = await admin.client().listPasskeys() as unknown as { authenticators: Array<{ id: string; credential_id_prefix: string }> };
  const pb = authenticators.find((k) => PB.exportCredential().id.startsWith(k.credential_id_prefix));
  assert.ok(pb, 'B\'s passkey is listed');
  const res = await admin.client().removePasskey(pb!.id);
  if (res?.rotated_token) admin.token = res.rotated_token;
  // Whatever device B holds now (re-enrolled above, or none), revoke it too.
  if (reEnrolledDevice && reEnrolledDevice !== revokedDeviceId) await admin.client().revokeDevice(reEnrolledDevice);
  const p = B.page;
  await p.evaluate(() => localStorage.removeItem('my-secrect:api-token'));
  await p.reload();
  await p.getByRole('heading', { name: 'Sign in to your account' }).waitFor();
  await signInViaUi(p, EMAIL);
  await p.getByText(/Sign-in failed|cancelled|not available/i).first().waitFor({ timeout: 20_000 });
  assert.equal(await storedToken(p), null, 'no session for B');
  assert.equal(await apiStatus(api.apiBase, aToken, 'GET', '/v1/vaults'), 200, 'A unaffected');
});
