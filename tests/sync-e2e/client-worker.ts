/**
 * One REAL client process: the real desktop vault module (apps/desktop/src/vault.ts),
 * the real SDK (VaultApiClient / SecurityApiClient), the real SyncClient via the
 * desktop SyncEngine, and real libsodium crypto. The only host shims are the ones a
 * browser provides: a file-backed `localStorage` (so a respawned process is a true
 * "reload" with the same persisted state), an optional connectivity switch that
 * makes `fetch` fail the way a dead network does, and a "response lost" switch
 * (the server handles the request, the client only sees the connection drop).
 *
 * Protocol: one JSON command per stdin line -> one JSON reply per stdout line.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import sodium from 'libsodium-wrappers-sumo';
import { deviceMessage, enrollPayload, sessionBindPayload, toBase64UrlNoPad } from '../../packages/sdk/src/device-identity';

const stateFile = process.env.CLIENT_STATE_FILE!;
const origin = process.env.WEBAUTHN_ORIGIN!;
const rpId = process.env.WEBAUTHN_RP_ID!;
const apiBase = process.env.API_BASE!;

const store: Record<string, string> = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const persist = () => writeFileSync(stateFile, JSON.stringify(store));
(globalThis as any).localStorage = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => { store[k] = String(v); persist(); },
  removeItem: (k: string) => { delete store[k]; persist(); },
};


// --- sign-up code (read from the mailed file) and device proof (specs/device-identity.md §6.1) ---
function mailCodes(e: string): string[] {
  try { return [...readFileSync(path.join(process.env.MAIL_DIR!, e), 'utf8').matchAll(/verification code is (\d{6})/g)].map((m) => m[1]); }
  catch { return []; }
}
async function waitForMailCode(e: string, seen: number): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const codes = mailCodes(e);
    if (codes.length > seen) return codes[codes.length - 1];
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no sign-up code was mailed to ${e}`);
}
async function deviceKeyPair() {
  await sodium.ready;
  let seedHex = localStorage.getItem('sync-e2e.device-seed');
  if (!seedHex) {
    seedHex = Buffer.from(sodium.randombytes_buf(32)).toString('hex');
    localStorage.setItem('sync-e2e.device-seed', seedHex);
  }
  return sodium.crypto_sign_seed_keypair(Uint8Array.from(Buffer.from(seedHex, 'hex')));
}
/** Enrol this client's Ed25519 device key at its first ceremony; bind to it afterwards. */
async function deviceProof(challenge: string) {
  const kp = await deviceKeyPair();
  const sign = (msg: Uint8Array) => toBase64UrlNoPad(sodium.crypto_sign_detached(msg, kp.privateKey));
  const deviceId = localStorage.getItem('sync-e2e.device-id');
  if (deviceId) return { id: deviceId, signature: sign(deviceMessage('session-bind', sessionBindPayload(challenge, deviceId))) };
  const publicKey = toBase64UrlNoPad(kp.publicKey);
  return { public_key: publicKey, signature: sign(deviceMessage('enroll', enrollPayload(challenge, publicKey))) };
}
function rememberDevice(res: any) {
  if (!res.device_id) throw new Error('session is not bound to a device (sync requires an active device)');
  localStorage.setItem('sync-e2e.device-id', res.device_id);
}

let online = process.env.START_OFFLINE !== '1';
// "Response lost": the request really reaches the server and completes there,
// then the reply is thrown away and the app sees a dead connection — the
// failure a retry must survive without duplicating or losing the write.
let lose: { match: string; count: number; thenOffline: boolean } | null = null;
let lostTotal = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  if (!online) throw new TypeError('fetch failed (simulated: network down)');
  const res = await realFetch(...args);
  const url = args[0] instanceof Request ? args[0].url : String(args[0]);
  if (lose && lose.count > 0 && url.includes(lose.match)) {
    lose.count -= 1;
    lostTotal += 1;
    if (lose.thenOffline) online = false;
    await res.arrayBuffer();
    throw new TypeError(`fetch failed (simulated: response lost after the server answered ${res.status})`);
  }
  return res;
}) as typeof fetch;

async function main() {
  const vault = await import('../../apps/desktop/src/vault.ts');
  const { SyncEngine } = await import('../../apps/desktop/src/sync/engine.ts');
  const { SecurityApiClient } = await import('../../packages/sdk/src/security.ts');
  const { SoftwareAuthenticator } = await import('./software-authenticator.ts');

  let token: string | null = store['sync-e2e.token'] ?? null; // models the persisted session token (webTokenStore)
  let engine: InstanceType<typeof SyncEngine> | null = null;
  let email = store['sync-e2e.email'] ?? ''; // models the persisted LS_ACCOUNT_EMAIL
  let itemsChanged = 0;
  let unauthorizedCalls = 0;

  function summary(item: any) {
    return { id: item.id, title: item.title, fields: item.fields, deleted_at: item.deleted_at ?? null };
  }

  const handlers: Record<string, (a: any) => Promise<unknown> | unknown> = {
    async createVault({ passphrase }) { return vault.createVault(passphrase); },
    async exportBackup() { return vault.exportEncrypted(); },
    async restoreBackup({ json, passphrase }) { await vault.restoreEncrypted(json, { passphrase }); return true; },
    async unlock({ passphrase }) { return vault.unlockVault(passphrase); },
    hasVault() { return vault.hasVault(); },
    lock() { engine?.stop(); engine = null; vault.lockVault(); return true; },
    setOnline({ online: v }) { online = v; return online; },
    loseResponses({ match, count, thenOffline }) { lose = { match, count, thenOffline: !!thenOffline }; return true; },
    lostResponses() { return lostTotal; },

    // --- account auth (real WebAuthn ceremony, verified by the Rails API) ---
    async register({ email: e, authenticator }) {
      email = e;
      localStorage.setItem('sync-e2e.email', e);
      const auth = SoftwareAuthenticator.importCredential(authenticator, origin, rpId);
      const sec = new SecurityApiClient({ baseUrl: apiBase, getToken: async () => null });
      const seen = mailCodes(email).length;
      await sec.requestEmailCode(email);
      const { registration_ticket } = await sec.verifyEmailCode(email, await waitForMailCode(email, seen));
      const opts: any = await sec.passkeyRegisterOptions(email, registration_ticket);
      const challenge = opts.creation_options.challenge;
      const cred = auth.create(challenge);
      const res: any = await sec.passkeyRegisterVerify(email, cred, await deviceProof(challenge));
      rememberDevice(res);
      token = res.token;
      localStorage.setItem('sync-e2e.token', token!);
      return { signedIn: !!token };
    },
    async signIn({ email: e, authenticator }) {
      email = e;
      localStorage.setItem('sync-e2e.email', e);
      const auth = SoftwareAuthenticator.importCredential(authenticator, origin, rpId);
      const sec = new SecurityApiClient({ baseUrl: apiBase, getToken: async () => null });
      const opts: any = await sec.passkeyAuthenticateOptions(email);
      const challenge = opts.request_options.challenge;
      const cred = auth.get(challenge);
      const res: any = await sec.passkeyLoginVerify(email, cred, await deviceProof(challenge));
      if (!res.token) throw new Error(`sign-in did not yield a session: ${JSON.stringify(Object.keys(res))}`);
      rememberDevice(res);
      token = res.token;
      localStorage.setItem('sync-e2e.token', token!);
      return { signedIn: true, authenticator: auth.exportCredential() };
    },

    // --- sync ---
    async startSync() {
      if (!token) throw new Error('not signed in');
      engine = new SyncEngine({
        baseUrl: apiBase, getToken: async () => token, accountKey: email,
        onItemsChanged: () => { itemsChanged += 1; },
        // What the app does (useSync + App): drop the stored token, then show sign-in.
        clearToken: () => { token = null; localStorage.removeItem('sync-e2e.token'); },
        onUnauthorized: () => { unauthorizedCalls += 1; },
        pushDebounceMs: Number(process.env.PUSH_DEBOUNCE_MS ?? 100),
        retryMs: Number(process.env.RETRY_MS ?? 400),
      });
      await engine.start();
      return engine.getStatus();
    },
    async syncNow() { await engine!.syncNow(); return engine!.getStatus(); },
    status() { return engine!.getStatus(); },
    conflicts() { return engine!.getConflicts(); },
    async keepBoth({ id }) { await engine!.resolveKeepBoth(id); return engine!.getStatus(); },
    itemsChanged() { return itemsChanged; },
    session() { return { hasToken: token !== null, unauthorizedCalls }; },

    // --- vault operations (the same functions the UI calls) ---
    async createItem({ id, title, fields, type }) {
      const now = new Date().toISOString();
      await vault.upsertItem({ id, type: type ?? 'login', schema_version: 1, title, fields, tags: [], relations: [], attachments: [], created_at: now, updated_at: now });
      return true;
    },
    async editItem({ id, title, fields }) {
      const cur = vault.listItems(true).find((i: any) => i.id === id);
      if (!cur) throw new Error(`no such item ${id}`);
      await vault.upsertItem({ ...cur, title: title ?? cur.title, fields: { ...cur.fields, ...(fields ?? {}) } });
      return true;
    },
    deleteItem({ id }) { vault.deleteItem(id); return true; },
    // Trash, then "Delete forever" straight away (the UI's two clicks, faster than the push debounce).
    deleteForever({ id }) { vault.deleteItem(id); vault.permanentlyDeleteItem(id); return true; },
    restoreItem({ id }) { vault.restoreItem(id); return true; },
    list() { return vault.listItems(true).map(summary); },
    rawStorage() { return { ...store }; },
  };

  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const msg = JSON.parse(line);
    try {
      const result = await handlers[msg.cmd](msg.args ?? {});
      process.stdout.write(JSON.stringify({ seq: msg.seq, ok: true, result }) + '\n');
    } catch (err) {
      const e = err as Error & { status?: number };
      process.stdout.write(JSON.stringify({ seq: msg.seq, ok: false, error: e.message, status: e.status }) + '\n');
    }
  });
  process.stdout.write(JSON.stringify({ ready: true }) + '\n');

}
main().catch((err) => { process.stderr.write(String(err?.stack ?? err) + '\n'); process.exit(1); });
