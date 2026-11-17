/**
 * One REAL client process: the real desktop vault module (apps/desktop/src/vault.ts),
 * the real SDK (VaultApiClient / SecurityApiClient), the real SyncClient via the
 * desktop SyncEngine, and real libsodium crypto. The only host shims are the ones a
 * browser provides: a file-backed `localStorage` (so a respawned process is a true
 * "reload" with the same persisted state) and an optional connectivity switch that
 * makes `fetch` fail the way a dead network does.
 *
 * Protocol: one JSON command per stdin line -> one JSON reply per stdout line.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

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

let online = process.env.START_OFFLINE !== '1';
const realFetch = globalThis.fetch;
globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
  if (!online) return Promise.reject(new TypeError('fetch failed (simulated: network down)'));
  return realFetch(...args);
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

    // --- account auth (real WebAuthn ceremony, verified by the Rails API) ---
    async register({ email: e, authenticator }) {
      email = e;
      localStorage.setItem('sync-e2e.email', e);
      const auth = SoftwareAuthenticator.importCredential(authenticator, origin, rpId);
      const sec = new SecurityApiClient({ baseUrl: apiBase, getToken: async () => null });
      const opts = await sec.passkeyRegisterOptions(email);
      const cred = auth.create((opts as any).creation_options.challenge);
      const res: any = await sec.passkeyRegisterVerify(email, cred);
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
      const cred = auth.get(opts.request_options.challenge);
      const res: any = await sec.passkeyLoginVerify(email, cred);
      if (!res.token) throw new Error(`sign-in did not yield a session: ${JSON.stringify(Object.keys(res))}`);
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
