/**
 * Scenario L client. A REAL client, not a mock: the desktop vault module
 * (apps/desktop/src/vault.ts, libsodium Argon2id + XChaCha20-Poly1305), the
 * desktop SyncEngine + SDK, the shared media pipeline (apps/desktop/src/utils/media.ts:
 * per-file key, chunk encryption, presigned PUT/GET), and a WebAuthn software
 * authenticator (tests/sync-e2e/software-authenticator.ts) whose ceremonies the
 * Rails API verifies. It reaches the stack only through Caddy (public origin
 * + s3.<site>), with Caddy's local root CA trusted via NODE_EXTRA_CA_CERTS.
 * Sign-up includes the email-ownership step: the 6-digit code is read from
 * the test mail catcher's HTTP API (MAILPIT_URL, docker-compose.test.yml), the
 * way a user reads their inbox. Every passkey ceremony carries a device proof
 * (specs/device-identity.md §6.1): each device holds its own Ed25519 key,
 * enrols it on its first ceremony and binds later sessions to it, because
 * vaults/sync/items answer 403 to a session without an active device.
 *
 *   tsx client.ts seed          sign up (email code + passkey + device), create vault,
 *                                push items, upload media
 *   tsx client.ts verify <label> FRESH device: restore the empty-vault backup
 *                                (passphrase or recovery key), passkey sign-in,
 *                                pull + decrypt every item, download + decrypt
 *                                the media blob, compare with what seed wrote.
 *   tsx client.ts delete         passkey step-up + DELETE /api/v1/auth/account.
 *
 * State lives in $SCENARIO_DIR (a throwaway temp dir, deleted by the runner).
 * Every token, challenge, assertion, ciphertext field and presigned-URL
 * signature this client sees is appended to $SCENARIO_DIR/needles.txt so the
 * runner can prove none of them reached a server log. stdout never prints them.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sodium from 'libsodium-wrappers-sumo';
import { deviceMessage, enrollPayload, sessionBindPayload, toBase64UrlNoPad } from '../../../packages/sdk/src/device-identity';

const need = (n: string) => { const v = process.env[n]; if (!v) throw new Error(`${n} is required`); return v; };
const DIR = need('SCENARIO_DIR');
const ORIGIN = need('SCENARIO_ORIGIN'); // e.g. https://localhost:19543 (== WEBAUTHN_ORIGIN)
const RP_ID = new URL(ORIGIN).hostname;
const API = `${ORIGIN}/api`;
const [phase, label = 'device'] = process.argv.slice(2);
const EXPECTED = path.join(DIR, 'expected.json');
const log = (m: string) => console.log(`[client:${phase}${phase === 'verify' ? ':' + label : ''}] ${m}`);

// ---- browser-shaped host: file-backed localStorage (one file per device)
const storeFile = path.join(DIR, `device-${phase === 'seed' ? 'seed' : label}.json`);
if (phase === 'verify' && existsSync(storeFile)) rmSync(storeFile); // a fresh device, always
const store: Record<string, string> = existsSync(storeFile) ? JSON.parse(readFileSync(storeFile, 'utf8')) : {};
const persist = () => writeFileSync(storeFile, JSON.stringify(store));
(globalThis as any).localStorage = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => { store[k] = String(v); persist(); },
  removeItem: (k: string) => { delete store[k]; persist(); },
};

// ---- record every secret-bearing value crossing the wire (for the log scan)
const NEEDLE_KEYS = /token|ticket|encrypted|ciphertext|signature|challenge|clientDataJSON|attestationObject|authenticatorData|userHandle|manifest|code|secret/i;
const needles = new Set<string>();
const addNeedle = (v: string) => { if (v.length >= 16) needles.add(v); };
function walk(v: unknown, key = ''): void {
  if (typeof v === 'string') { if (NEEDLE_KEYS.test(key)) addNeedle(v); return; }
  if (Array.isArray(v)) { v.forEach((x) => walk(x, key)); return; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
}
const collect = (text: string) => { try { walk(JSON.parse(text)); } catch { /* not JSON */ } };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const sig = url.searchParams.get('X-Amz-Signature');
  if (sig) addNeedle(sig);
  if (typeof init?.body === 'string') collect(init.body);
  const res = await realFetch(input, init);
  if (url.origin === ORIGIN) collect(await res.clone().text());
  return res;
}) as typeof fetch;
const flushNeedles = () => { if (needles.size) appendFileSync(path.join(DIR, 'needles.txt'), [...needles].join('\n') + '\n'); };

const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

// ---- sign-up code from the test mail catcher (Mailpit HTTP API, newest first)
const MAILPIT = need('MAILPIT_URL');
async function mailedCodes(email: string): Promise<string[]> {
  const list: any = await (await realFetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json();
  const codes: string[] = [];
  for (const m of [...(list.messages ?? [])].reverse()) {
    const msg: any = await (await realFetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
    const hit = /verification code is (\d{6})/.exec(String(msg.Text ?? ''));
    if (hit) codes.push(hit[1]);
  }
  return codes;
}
async function waitForCode(email: string, seen: number): Promise<string> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const codes = await mailedCodes(email);
    if (codes.length > seen) return codes[codes.length - 1];
    if (Date.now() > deadline) throw new Error('no sign-up code reached the test mailbox');
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ---- this device's Ed25519 key, kept in its localStorage (specs/device-identity.md §6.1)
const LS_DEVICE_SEED = 'scenario-l.device-seed';
const LS_DEVICE_ID = 'scenario-l.device-id';
async function deviceProof(challenge: string) {
  await sodium.ready;
  let seed = localStorage.getItem(LS_DEVICE_SEED);
  if (!seed) { seed = Buffer.from(sodium.randombytes_buf(32)).toString('hex'); localStorage.setItem(LS_DEVICE_SEED, seed); }
  const kp = sodium.crypto_sign_seed_keypair(Uint8Array.from(Buffer.from(seed, 'hex')));
  const sign = (msg: Uint8Array) => toBase64UrlNoPad(sodium.crypto_sign_detached(msg, kp.privateKey));
  const id = localStorage.getItem(LS_DEVICE_ID);
  if (id) return { id, signature: sign(deviceMessage('session-bind', sessionBindPayload(challenge, id))) };
  const publicKey = toBase64UrlNoPad(kp.publicKey);
  return { public_key: publicKey, signature: sign(deviceMessage('enroll', enrollPayload(challenge, publicKey))) };
}
function rememberDevice(res: any) {
  assert.ok(res.device_id, 'the session is bound to a device');
  localStorage.setItem(LS_DEVICE_ID, res.device_id);
}

interface Expected {
  email: string;
  passphrase: string;
  recoveryKey: string;
  emptyBackup: string;
  seedToken: string;
  lastToken?: string;
  authenticator: { id: string; privateKeyPem: string; signCount: number };
  items: Array<{ id: string; type: string; title: string; fields: Record<string, unknown> }>;
  media: { itemId: string; blobId: string; sha256: string; size: number; fileName: string };
}

async function main() {
  const vault = await import('../../../apps/desktop/src/vault.ts');
  const { SyncEngine } = await import('../../../apps/desktop/src/sync/engine.ts');
  const { uploadMediaFile, downloadMediaItem } = await import('../../../apps/desktop/src/utils/media.ts');
  const { VaultApiClient } = await import('../../../packages/sdk/src/index.ts');
  const { SecurityApiClient } = await import('../../../packages/sdk/src/security.ts');
  const { SoftwareAuthenticator } = await import('../../../tests/sync-e2e/software-authenticator.ts');
  const anon = new SecurityApiClient({ baseUrl: API, getToken: async () => null });

  async function syncOnce(token: string, email: string) {
    const engine = new SyncEngine({ baseUrl: API, getToken: async () => token, accountKey: email, pushDebounceMs: 50, retryMs: 500 });
    await engine.start();
    await engine.syncNow();
    const st = engine.getStatus();
    return { engine, st };
  }

  if (phase === 'seed') {
    const email = `scenario-l-${randomBytes(6).toString('hex')}@example.test`;
    const passphrase = `scenario L ${randomBytes(12).toString('base64url')}`;
    addNeedle(passphrase);
    const auth = SoftwareAuthenticator.create(ORIGIN, RP_ID);
    const seen = (await mailedCodes(email)).length;
    await anon.requestEmailCode(email);
    const { registration_ticket } = await anon.verifyEmailCode(email, await waitForCode(email, seen));
    const opts: any = await anon.passkeyRegisterOptions(email, registration_ticket);
    const challenge = opts.creation_options.challenge;
    const reg: any = await anon.passkeyRegisterVerify(email, auth.create(challenge), await deviceProof(challenge));
    rememberDevice(reg);
    const token: string = reg.token;
    assert.ok(token, 'registration returned a session token');
    log('account registered: email code from the test mailbox -> ticket -> real WebAuthn attestation + device enrolment, verified by the API');

    const { recoveryKey } = await vault.createVault(passphrase);
    addNeedle(recoveryKey);
    const emptyBackup = vault.exportEncrypted(); // wrapped key envelope only: how a second device joins
    assert.equal(await vault.unlockVault(passphrase), true);

    const markers = () => `MARK-${randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();
    const items = [
      { id: `item_${randomBytes(12).toString('hex')}`, type: 'login', title: `Bank ${markers()}`, fields: { username: 'alice', password: markers(), url: 'https://bank.example' } },
      { id: `item_${randomBytes(12).toString('hex')}`, type: 'secure_note', title: `Note ${markers()}`, fields: { notes: `line one ${markers()}\nline two` } },
      { id: `item_${randomBytes(12).toString('hex')}`, type: 'identity', title: `Passport ${markers()}`, fields: { full_name: 'Alice Example', document_number: markers() } },
      { id: `item_${randomBytes(12).toString('hex')}`, type: 'api_key', title: `API key ${markers()}`, fields: { key_name: 'deploy', secret: markers() } },
    ];
    for (const it of items) {
      for (const v of [it.title, ...Object.values(it.fields).map(String)]) if (v.includes('MARK-')) addNeedle(v.match(/MARK-[0-9a-f]{16}/)![0]);
      await vault.upsertItem({ ...it, schema_version: 1, tags: [], relations: [], attachments: [], created_at: now, updated_at: now } as any);
    }
    const { engine, st } = await syncOnce(token, email);
    assert.equal(st.state, 'idle', `sync status after push: ${JSON.stringify(st)}`);
    assert.equal(st.pending, 0, 'nothing left in the push queue');
    log(`${items.length} items encrypted locally and pushed (sync idle, 0 pending)`);

    // Media: 2.5 MiB random "PDF" -> 3 encrypted 1 MiB chunks via presigned PUT on s3.<site>.
    const bytes = new Uint8Array(randomBytes(2 * 1024 * 1024 + 512 * 1024));
    bytes.set(new TextEncoder().encode('%PDF-1.7 scenario-L'), 0);
    const fileName = `scenario-l-${randomBytes(4).toString('hex')}.pdf`;
    const api = new VaultApiClient({ baseUrl: API, getToken: async () => token });
    const { item: mediaItem } = await uploadMediaFile({
      api, file: new File([bytes], fileName, { type: 'application/pdf' }),
      withVaultKey: vault.withVaultKey,
      makeEncryptedMetadataB64: () => vault.encryptWithVaultKey(JSON.stringify({ name: 'My vault' })),
    });
    await vault.upsertItem(mediaItem);
    await engine.syncNow();
    assert.equal(engine.getStatus().state, 'idle');
    assert.equal(engine.getStatus().pending, 0);
    const blobId = String((mediaItem.fields as any).blob_id);
    const back = await downloadMediaItem({ api, item: mediaItem, withVaultKey: vault.withVaultKey });
    assert.equal(sha256Hex(new Uint8Array(await back.blob.arrayBuffer())), sha256Hex(bytes), 'baseline download equals upload');
    engine.stop();
    log(`media uploaded as encrypted chunks and its vault item synced; baseline download+decrypt OK (${bytes.length} bytes)`);

    const expected: Expected = {
      email, passphrase, recoveryKey, emptyBackup, seedToken: token,
      authenticator: auth.exportCredential(),
      items,
      media: { itemId: mediaItem.id, blobId, sha256: sha256Hex(bytes), size: bytes.length, fileName },
    };
    writeFileSync(EXPECTED, JSON.stringify(expected));
    flushNeedles();
    log(`SEED_OK items=${items.length} media=1`);
    return;
  }

  if (phase === 'verify') {
    const exp: Expected = JSON.parse(readFileSync(EXPECTED, 'utf8'));
    // 1. The seed session (issued before backup) is still accepted: sessions table restored.
    const seedApi = new VaultApiClient({ baseUrl: API, getToken: async () => exp.seedToken });
    const { vaults } = await seedApi.listVaults();
    assert.equal(vaults.length, 1, 'the account still has exactly its one vault');
    log('seed session token still valid; account has its 1 vault');

    // 2. Fresh device: restore the empty-vault backup. Odd runs use the passphrase,
    //    the `recovery` label uses the recovery key (both unwrap the same vault key).
    const secret = label.includes('recovery') ? { recoveryKey: exp.recoveryKey } : { passphrase: exp.passphrase };
    await vault.restoreEncrypted(exp.emptyBackup, secret as any);
    assert.equal(vault.isUnlocked(), true);
    assert.equal(vault.listItems(true).length, 0, 'fresh device starts with no items');
    log(`fresh device restored the key envelope with the ${'recoveryKey' in secret ? 'recovery key' : 'passphrase'}`);

    // 3. Passkey sign-in against the (restored) authenticators table.
    const auth = SoftwareAuthenticator.importCredential(exp.authenticator, ORIGIN, RP_ID);
    const opts: any = await anon.passkeyAuthenticateOptions(exp.email);
    const challenge = opts.request_options.challenge;
    const signed: any = await anon.passkeyLoginVerify(exp.email, auth.get(challenge), await deviceProof(challenge));
    assert.ok(signed.token, 'passkey sign-in returned a session token');
    rememberDevice(signed);
    exp.authenticator = auth.exportCredential(); // keep the advanced sign counter for the next run
    writeFileSync(EXPECTED, JSON.stringify(exp));
    log('passkey sign-in OK (assertion verified against the stored public key + sign counter); this new device enrolled its key');

    // 4. Pull + decrypt everything from the server.
    const { engine, st } = await syncOnce(signed.token, exp.email);
    assert.equal(st.state, 'idle', `sync status after pull: ${JSON.stringify(st)}`);
    const got = vault.listItems(true);
    assert.equal(got.length, exp.items.length + 1, `item count (got ${got.length})`);
    for (const want of exp.items) {
      const it = got.find((g: any) => g.id === want.id);
      assert.ok(it, `item ${want.id} present`);
      assert.equal(it!.title, want.title, `title of ${want.id}`);
      assert.deepEqual(it!.fields, want.fields, `fields of ${want.id}`);
      assert.equal(it!.type, want.type);
      assert.equal(it!.deleted_at ?? null, null);
    }
    log(`${exp.items.length}/${exp.items.length} items pulled from the server and decrypted; titles + fields identical`);

    // 5. Media: item came back through sync; download + verify + decrypt the blob.
    const mediaItem = got.find((g: any) => g.id === exp.media.itemId);
    assert.ok(mediaItem, 'media item present');
    const api = new VaultApiClient({ baseUrl: API, getToken: async () => signed.token });
    const dl = await downloadMediaItem({ api, item: mediaItem!, withVaultKey: vault.withVaultKey });
    const dlBytes = new Uint8Array(await dl.blob.arrayBuffer());
    assert.equal(dl.sha256Matches, true, 'sha256 recorded in the item matches');
    assert.equal(dlBytes.length, exp.media.size);
    assert.equal(sha256Hex(dlBytes), exp.media.sha256);
    assert.equal(dl.fileName, exp.media.fileName);
    engine.stop();
    exp.lastToken = signed.token;
    writeFileSync(EXPECTED, JSON.stringify(exp));
    flushNeedles();
    log(`media blob downloaded, chunk hashes verified, decrypted; sha256 identical (${dlBytes.length} bytes)`);
    log('VERIFY_OK');
    return;
  }

  if (phase === 'delete') {
    // Account deletion exactly as the Security Center does it: passkey step-up, then DELETE.
    const exp: Expected = JSON.parse(readFileSync(EXPECTED, 'utf8'));
    const token = exp.lastToken!;
    const sec = new SecurityApiClient({ baseUrl: API, getToken: async () => token });
    await assert.rejects(sec.deleteAccount(), (e: any) => e.status === 403, 'DELETE without a fresh step-up is refused');
    const auth = SoftwareAuthenticator.importCredential(exp.authenticator, ORIGIN, RP_ID);
    const so: any = await sec.stepUpPasskeyOptions();
    await sec.stepUpPasskey(auth.get(so.request_options.challenge));
    await sec.deleteAccount();
    for (const t of [token, exp.seedToken]) {
      await assert.rejects(new VaultApiClient({ baseUrl: API, getToken: async () => t }).listVaults(), (e: any) => e.status === 401);
    }
    flushNeedles();
    log('DELETE /api/v1/auth/account: 403 without step-up, 204 after passkey step-up; every session token now 401');
    log('DELETE_OK');
    return;
  }
  throw new Error(`unknown phase ${phase}`);
}

main().then(() => process.exit(0), (err) => { flushNeedles(); console.error(`[client] FAIL: ${err?.stack ?? err}`); process.exit(1); });
