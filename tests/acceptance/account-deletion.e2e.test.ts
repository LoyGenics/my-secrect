/**
 * Acceptance M — account deletion through the product, end to end.
 *
 * Real stack: Rails API + Postgres, the web app in real Chromium (CDP virtual
 * authenticator, real WebAuthn), and a real MinIO container as object storage
 * (presigned uploads straight from the browser). Docker-less machines skip
 * only the object-storage assertions and say so.
 *
 * Flow: register in the UI -> create vault -> items synced -> encrypted media
 * uploaded through the Media gallery -> a second browser signs in (second
 * session) -> Security Center "Delete account" with passkey step-up. Then:
 *   - every session of the account is dead (both browsers' tokens -> 401);
 *   - no row anywhere in Postgres still belongs to the account;
 *   - no ciphertext object is left in the bucket;
 *   - the old passkey cannot sign in; the email can register again as a NEW
 *     empty account (nothing resurrected);
 *   - the local vault on the device is NOT erased (the UI says so up front).
 *
 * Run: npx tsx --test --test-concurrency=1 tests/acceptance/account-deletion.e2e.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startApi, startMinio, startWeb, type RunningApi, type RunningMinio } from './lib/stack.ts';
import { addPasskeyViaUi, apiStatus, createVaultViaUi, freshDevice, registerViaUi, signInViaUi, storedToken, unlockViaUi, LS_VAULT_KEYS, LS_VAULT_ROWS, type VirtualAuthenticator } from './lib/browser.ts';

const API_PORT = Number(process.env.ACCEPT_M_API_PORT ?? 3255);
const WEB_PORT = Number(process.env.ACCEPT_M_WEB_PORT ?? 5367);
const MINIO_PORT = Number(process.env.ACCEPT_M_MINIO_PORT ?? 19701);
const WEB = `http://localhost:${WEB_PORT}`;
const DB = 'vault_m_a15_e2eauth';
const PASS = 'acceptance M passphrase 3';
const EMAIL = `m-delete-${Date.now()}@example.test`;

let api: RunningApi;
let web: { stop(): Promise<void> };
let minio: RunningMinio | null = null;
let browser: Browser;
let A: { ctx: BrowserContext; page: Page; auth: VirtualAuthenticator };
let B: { ctx: BrowserContext; page: Page; auth: VirtualAuthenticator };
let userId = '';
let vaultIds: string[] = [];
let tokenA = '';
let tokenB = '';

before(async () => {
  minio = process.env.ACCEPT_NO_DOCKER ? null : await startMinio(MINIO_PORT, WEB);
  api = await startApi({ port: API_PORT, db: DB, webOrigin: WEB, s3: minio ?? undefined });
  web = await startWeb(WEB_PORT);
  browser = await chromium.launch();
});
after(async () => {
  await A?.ctx.close().catch(() => undefined);
  await B?.ctx.close().catch(() => undefined);
  await browser?.close();
  await web?.stop();
  await api?.stop();
  await minio?.stop();
});

const count = (sql: string) => Number(api.psql(sql));

test('A registers, creates a vault, syncs items and uploads encrypted media through the UI', async () => {
  A = await freshDevice(browser, api.apiBase);
  const p = A.page;
  await registerViaUi(p, WEB, EMAIL, api.mailDir);
  await createVaultViaUi(p, PASS);
  await addPasskeyViaUi(p, EMAIL, api.mailDir);
  // Adding the passkey left a fresh email step-up on this session; sign in
  // again with the passkey so "Delete account" below needs its own step-up.
  await p.getByRole('button', { name: 'Sign out', exact: true }).click();
  await p.getByRole('heading', { name: 'Sign in to your account' }).waitFor();
  await signInViaUi(p, EMAIL);
  await unlockViaUi(p, PASS);
  for (const title of ['M-ITEM-alpha', 'M-ITEM-beta']) {
    await p.getByRole('button', { name: /^New item/ }).click();
    await p.locator('#item-title').fill(title);
    await p.getByLabel('Password', { exact: true }).first().fill(`pw-${title}`);
    await p.getByRole('button', { name: 'Save', exact: true }).click();
    await p.getByText(title).first().waitFor();
  }
  await p.getByTestId('sync-status').and(p.locator('[data-state="idle"]')).waitFor({ timeout: 30_000 });
  tokenA = (await storedToken(p))!;
  userId = api.psql(`SELECT id FROM users WHERE email='${EMAIL}'`);
  assert.match(userId, /^[0-9a-f-]{36}$/);
  vaultIds = api.psql(`SELECT id FROM vaults WHERE owner_id='${userId}'`).split('\n').filter(Boolean);
  assert.equal(vaultIds.length, 1);
  await waitForRows(() => count(`SELECT count(*) FROM items WHERE vault_id='${vaultIds[0]}'`) >= 2, 'items pushed');

  if (minio) {
    const dir = mkdtempSync(path.join(tmpdir(), 'accept-m-'));
    const file = path.join(dir, 'm-secret-scan.bin');
    writeFileSync(file, Buffer.alloc(1024 * 1024 + 4096, 7)); // 2 chunks
    await p.getByRole('button', { name: /Media gallery/ }).click();
    await p.setInputFiles('[data-testid="media-upload-input"]', file);
    await p.getByText(/Uploaded “m-secret-scan.bin” as encrypted chunks/).waitFor({ timeout: 60_000 });
    assert.ok(minio.listKeys().length >= 2, 'ciphertext chunks are in the bucket');
    assert.ok(count(`SELECT count(*) FROM blobs WHERE vault_id='${vaultIds[0]}'`) >= 1);
  }
});

test('B signs in on a second browser with the same (synced) passkey: two live sessions', async () => {
  B = await freshDevice(browser, api.apiBase);
  await B.auth.importAll(await A.auth.exportAll());
  await B.page.goto(WEB);
  await signInViaUi(B.page, EMAIL);
  await B.page.getByText('Create your local vault').waitFor();
  tokenB = (await storedToken(B.page))!;
  // Keep A's authenticator counter ahead of the server (clone detection is real).
  await A.auth.clear();
  await A.auth.importAll(await B.auth.exportAll());
  assert.equal(await apiStatus(api.apiBase, tokenA, 'GET', '/v1/auth/sessions'), 200);
  assert.equal(await apiStatus(api.apiBase, tokenB, 'GET', '/v1/auth/sessions'), 200);
  assert.equal(count(`SELECT count(*) FROM sessions WHERE user_id='${userId}' AND revoked_at IS NULL`), 2);
});

test('Delete account in the Security Center (passkey step-up) ends every session and returns to sign-in', async () => {
  const p = A.page;
  await p.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
  await p.getByRole('button', { name: /Security Center/ }).first().click();
  const del = p.locator('section').filter({ has: p.getByRole('heading', { name: 'Delete account', exact: true }) });
  await del.getByText(/The vault stored on this device is not erased/).waitFor();
  await del.getByRole('button', { name: 'Delete account', exact: true }).click();
  await del.getByRole('button', { name: 'Confirm', exact: true }).click();
  const dialog = p.getByRole('dialog');
  await dialog.getByRole('radio', { name: 'Use a passkey' }).check();
  await dialog.getByRole('button', { name: 'Use a passkey' }).click();
  await p.getByRole('heading', { name: 'Sign in to your account' }).waitFor({ timeout: 30_000 });
  assert.equal(await storedToken(p), null);
  for (const [name, token] of [['A', tokenA], ['B', tokenB]] as const) {
    for (const route of ['/v1/auth/sessions', '/v1/vaults', `/v1/vaults/${vaultIds[0]}/sync`, '/v1/devices']) {
      assert.equal(await apiStatus(api.apiBase, token, 'GET', route), 401, `${name} ${route}`);
    }
  }
});

test('server: no row in any table still belongs to the account; audit trail kept only without the user link', async () => {
  const uid = userId;
  const v = vaultIds.map((x) => `'${x}'`).join(',');
  const checks: Record<string, string> = {
    users: `SELECT count(*) FROM users WHERE id='${uid}' OR email='${EMAIL}'`,
    sessions: `SELECT count(*) FROM sessions WHERE user_id='${uid}'`,
    devices: `SELECT count(*) FROM devices WHERE user_id='${uid}'`,
    authenticators: `SELECT count(*) FROM authenticators WHERE user_id='${uid}'`,
    vaults: `SELECT count(*) FROM vaults WHERE id IN (${v}) OR owner_id='${uid}'`,
    items: `SELECT count(*) FROM items WHERE vault_id IN (${v})`,
    item_versions_orphans: `SELECT count(*) FROM item_versions iv LEFT JOIN items i ON i.id = iv.item_id WHERE i.id IS NULL`,
    sync_events: `SELECT count(*) FROM sync_events WHERE vault_id IN (${v})`,
    blobs: `SELECT count(*) FROM blobs WHERE vault_id IN (${v})`,
    blob_parts_orphans: `SELECT count(*) FROM blob_parts bp LEFT JOIN blobs b ON b.id = bp.blob_id WHERE b.id IS NULL`,
    key_envelopes: `SELECT count(*) FROM key_envelopes WHERE vault_id IN (${v})`,
    mfa_challenges: `SELECT count(*) FROM mfa_challenges WHERE user_id='${uid}'`,
    passkey_challenges: `SELECT count(*) FROM passkey_challenges WHERE email='${EMAIL}'`,
    recovery_codes: `SELECT count(*) FROM recovery_codes WHERE user_id='${uid}'`,
    recovery_verifiers: `SELECT count(*) FROM recovery_verifiers WHERE user_id='${uid}'`,
    audit_events_linked: `SELECT count(*) FROM audit_events WHERE user_id='${uid}'`,
    // Tables added on main (email sign-up, device keys, identity keys, item sharing).
    device_challenges: `SELECT count(*) FROM device_challenges WHERE user_id='${uid}'`,
    email_verifications: `SELECT count(*) FROM email_verifications WHERE email='${EMAIL}' OR pending_user_id='${uid}'`,
    identity_keys: `SELECT count(*) FROM identity_keys WHERE user_id='${uid}'`,
    item_shares: `SELECT count(*) FROM item_shares WHERE owner_id='${uid}' OR recipient_id='${uid}'`,
    shares: `SELECT count(*) FROM shares WHERE owner_id='${uid}' OR recipient_id='${uid}'`,
  };
  const left = Object.entries(checks).map(([t, sql]) => [t, count(sql)] as const).filter(([, n]) => n > 0);
  assert.deepEqual(left, [], `rows left after deletion: ${JSON.stringify(left)}`);
  // Whatever stays in the database must not contain the email anywhere.
  assert.equal(count(`SELECT count(*) FROM audit_events WHERE metadata::text LIKE '%${EMAIL}%'`), 0);
});

test('object storage: no ciphertext object of the account is left in the bucket', { skip: process.env.ACCEPT_NO_DOCKER ? 'ACCEPT_NO_DOCKER set' : false }, () => {
  assert.ok(minio, 'MinIO (docker image cgr.dev/chainguard/minio) unavailable: object-storage deletion NOT verified');
  assert.deepEqual(minio!.listKeys(), []);
});

test('the deleted account\'s passkey cannot sign in; the email registers again as a NEW empty account', async () => {
  const p = A.page;
  await signInViaUi(p, EMAIL);
  await p.getByText(/Sign-in failed|cancelled|not available/).first().waitFor();
  assert.equal(await storedToken(p), null);
  // The local vault on this device is untouched (account deletion is not a device wipe).
  const local = await p.evaluate(([k, r]) => ({ keys: localStorage.getItem(k), rows: localStorage.getItem(r) }), [LS_VAULT_KEYS, LS_VAULT_ROWS]);
  assert.ok(local.keys && local.rows, 'local vault still on the device, as the UI promised');
  // Fresh registration with the same email: a different user id, no vault, no items.
  const C = await freshDevice(browser, api.apiBase);
  try {
    await registerViaUi(C.page, WEB, EMAIL, api.mailDir);
    const newId = api.psql(`SELECT id FROM users WHERE email='${EMAIL}'`);
    assert.notEqual(newId, userId);
    assert.equal(count(`SELECT count(*) FROM vaults WHERE owner_id='${newId}'`), 0);
  } finally {
    await C.ctx.close();
  }
});

async function waitForRows(cond: () => boolean, label: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
