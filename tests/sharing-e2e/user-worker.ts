/**
 * One REAL user device for the sharing e2e, in its own process:
 *  - the real desktop vault module (apps/desktop/src/vault.ts) — the only
 *    host shim is an in-memory `localStorage`, as a browser provides;
 *  - the real SDK: SecurityApiClient for the WebAuthn ceremony (verified by
 *    the API's `webauthn` gem), SharingSession / SharingApiClient for sharing;
 *  - real libsodium.
 * Nothing in the sharing path is mocked. Protocol: one JSON command per
 * stdin line -> one JSON reply per stdout line.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

const origin = process.env.WEBAUTHN_ORIGIN!;
const rpId = process.env.WEBAUTHN_RP_ID!;
const apiBase = process.env.API_BASE!;
const mailDir = process.env.MAIL_DIR!;

/** Sign-up codes mailed to `email` (the API's :file delivery = this user's inbox). */
function mailedCodes(email: string): string[] {
  let text = '';
  try { text = readFileSync(path.join(mailDir, email), 'utf8'); } catch { /* nothing mailed yet */ }
  return [...text.matchAll(/verification code is (\d{6})/g)].map((m) => m[1]);
}
async function waitForNewCode(email: string, seen: number): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const codes = mailedCodes(email);
    if (codes.length > seen) return codes[codes.length - 1];
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`no verification code was mailed to ${email}`);
}

async function main() {
  const vault = await import('../../apps/desktop/src/vault.ts');
  const { SecurityApiClient } = await import('../../packages/sdk/src/security.ts');
  const { SharingApiClient, SharingSession } = await import('../../packages/sdk/src/sharing.ts');
  const core = await import('../../packages/core/src/sharing.ts');
  const { SoftwareAuthenticator } = await import('./software-authenticator.ts');

  let token: string | null = null;
  let session: InstanceType<typeof SharingSession> | null = null;
  let authenticator: InstanceType<typeof SoftwareAuthenticator> | null = null;
  let accountEmail = '';
  const reviewed = new Map<string, any>(); // shareId -> the OpenedShare the user was shown
  const api = new SharingApiClient({ baseUrl: apiBase, getToken: async () => token });
  const vaultCipher = { encrypt: vault.encryptWithVaultKey, decrypt: vault.decryptWithVaultKey };
  const items = { find: (id: string) => vault.listItems(true).find((i) => i.id === id), save: vault.upsertItem };
  const sec = () => new SecurityApiClient({ baseUrl: apiBase, getToken: async () => null });

  const s = () => {
    if (!session) throw new Error('sharing not started');
    return session;
  };
  async function share(id: string) {
    const found = (await s().listShares()).find((x) => x.id === id);
    if (!found) throw new Error(`no such share ${id}`);
    return found;
  }
  /** What a second device of this account does: load the identity and the
   *  pins from scratch, without the running session. */
  async function freshDevice() {
    const reg = await api.getIdentityKey();
    if (!reg) throw new Error('no identity registered');
    const identity = await core.decryptIdentity(reg.encrypted_secret_key, reg.public_key, vaultCipher);
    const pins = await core.PinStore.open((globalThis as any).localStorage, reg.user_id, vaultCipher);
    return { identity, pins };
  }

  const handlers: Record<string, (a: any) => Promise<unknown> | unknown> = {
    /** Sign-up as on main: emailed code -> registration ticket -> passkey. */
    async register({ email }) {
      const auth = SoftwareAuthenticator.create(origin, rpId);
      const seen = mailedCodes(email).length;
      await sec().requestEmailCode(email);
      const { registration_ticket: ticket } = await sec().verifyEmailCode(email, await waitForNewCode(email, seen));
      const opts: any = await sec().passkeyRegisterOptions(email, ticket);
      const res: any = await sec().passkeyRegisterVerify(email, auth.create(opts.creation_options.challenge));
      if (!res.token) throw new Error('registration did not yield a session');
      token = res.token;
      authenticator = auth;
      accountEmail = email;
      return { authenticator: auth.exportCredential() };
    },
    async signIn({ email, authenticator: exported }) {
      const auth = SoftwareAuthenticator.importCredential(exported, origin, rpId);
      const opts: any = await sec().passkeyAuthenticateOptions(email);
      const res: any = await sec().passkeyLoginVerify(email, auth.get(opts.request_options.challenge));
      if (!res.token) throw new Error('sign-in did not yield a session');
      token = res.token;
      authenticator = auth;
      accountEmail = email;
      return { authenticator: auth.exportCredential() };
    },
    /** A synced passkey: take over the credential state another device of
     *  this account last used (the server requires the counter to grow). */
    adoptPasskey({ authenticator: exported }) {
      authenticator = SoftwareAuthenticator.importCredential(exported, origin, rpId);
      return true;
    },
    /** Server step-up with this device's passkey (as StepUpDialog does). */
    async stepUp() {
      if (!authenticator) throw new Error('no passkey on this device');
      const authed = new SecurityApiClient({ baseUrl: apiBase, getToken: async () => token });
      const opts: any = await authed.stepUpPasskeyOptions();
      await authed.stepUpPasskey(authenticator.get(opts.request_options.challenge));
      return { email: accountEmail, authenticator: authenticator.exportCredential() };
    },
    async createVault({ passphrase }) { await vault.createVault(passphrase); return true; },
    exportBackup() { return vault.exportEncrypted(); },
    async restoreBackup({ json, passphrase }) { await vault.restoreEncrypted(json, { passphrase }); return true; },
    async unlock({ passphrase }) { return vault.unlockVault(passphrase); },
    async createItem({ id, title, type, fields }) {
      const now = new Date().toISOString();
      await vault.upsertItem({ id, type: type ?? 'login', schema_version: 1, title, fields, tags: ['shared-e2e'], relations: [{ type: 'has_login', target_id: 'item_private_graph' }], attachments: [], created_at: now, updated_at: now });
      return true;
    },
    async editItem({ id, title, fields }) {
      const cur = vault.listItems(true).find((i) => i.id === id);
      if (!cur) throw new Error(`no such item ${id}`);
      await vault.upsertItem({ ...cur, title: title ?? cur.title, fields: { ...cur.fields, ...(fields ?? {}) }, updated_at: new Date().toISOString() });
      return true;
    },
    item({ id }) { return vault.listItems(true).find((i) => i.id === id) ?? null; },

    // --- sharing, exactly the calls the UIs make ---
    async startSharing() {
      session?.close();
      session = null;
      session = await SharingSession.start({ api, vault: vaultCipher, pinStorage: (globalThis as any).localStorage, items });
      return { userId: session.userId, publicKey: session.publicKey, fingerprint: await session.myFingerprint() };
    },
    async resetIdentity() {
      session?.close();
      session = null;
      session = await SharingSession.resetIdentity({ api, vault: vaultCipher, pinStorage: (globalThis as any).localStorage, items });
      return { userId: session.userId, publicKey: session.publicKey, fingerprint: await session.myFingerprint() };
    },
    async peerView({ shareId }) { return s().peerView(await share(shareId)); },
    lookup({ email }) { return s().lookupContact(email); },
    verifyContact({ contact }) { return s().verifyContact(contact); },
    async shareItem({ itemId, contact, permission, expiresAt }) {
      const item = items.find(itemId);
      if (!item) throw new Error(`no such item ${itemId}`);
      return s().shareItem({ item, contact, permission, expiresAt });
    },
    listShares() { return s().listShares(); },
    async verifyIncoming({ shareId }) { await s().verifyIncoming(await share(shareId)); return true; },
    async accept({ shareId }) { return s().acceptShare(await share(shareId)); },
    /** Open = what the UI shows; the worker keeps it as the reviewed revision. */
    async open({ shareId }) {
      const opened = await s().openShare(await share(shareId));
      reviewed.set(shareId, opened);
      return opened;
    },
    async edit({ shareId, title, fields }) {
      const sh = await share(shareId);
      const opened = await s().openShare(sh);
      return s().writeShare(sh, { ...opened.item, title: title ?? opened.item.title, fields: { ...opened.item.fields, ...(fields ?? {}) } }, opened.revision);
    },
    async writeAt({ shareId, baseRevision, title }) {
      const sh = await share(shareId);
      const opened = await s().openShare(sh);
      return s().writeShare(sh, { ...opened.item, title }, baseRevision);
    },
    async revoke({ shareId }) { await s().revokeShare(await share(shareId)); return true; },
    /** "Save this version to my vault" for the revision last opened (shown). */
    async saveToVault({ shareId }) {
      const shown = reviewed.get(shareId);
      if (!shown) throw new Error('open the share before saving it');
      return s().saveToVault(await share(shareId), shown);
    },
    async sendLatest({ shareId }) { return s().sendLatestVersion(await share(shareId)); },
    rawGetRecord({ shareId }) { return api.getRecord(shareId); },

    // --- crypto-only paths (no server access needed) ---
    async decryptWith({ shareId, revision, encrypted_payload, encrypted_item_key, peerUserId, peerPublicKey, peerEmail }) {
      const { identity, pins } = await freshDevice();
      try {
        const peer = await pins.requireVerified(peerUserId, peerPublicKey, peerEmail);
        return await core.decryptShareRecord({ encrypted_payload, encrypted_item_key }, { shareId, revision, self: identity, peerPublicKey: peer });
      } finally {
        core.wipeIdentity(identity);
      }
    },
    async encryptFor({ shareId, revision, item, peerUserId, peerPublicKey, peerEmail }) {
      const { identity, pins } = await freshDevice();
      try {
        const peer = await pins.requireVerified(peerUserId, peerPublicKey, peerEmail);
        return await core.encryptShareRecord(item, { shareId, revision, self: identity, peerPublicKey: peer });
      } finally {
        core.wipeIdentity(identity);
      }
    },
    storageValues() { return [...store.values()]; },
  };

  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const msg = JSON.parse(line);
    try {
      const result = await handlers[msg.cmd](msg.args ?? {});
      process.stdout.write(JSON.stringify({ seq: msg.seq, ok: true, result: result ?? null }) + '\n');
    } catch (err) {
      const e = err as Error & { status?: number };
      process.stdout.write(JSON.stringify({ seq: msg.seq, ok: false, error: e.message, name: e.name, status: e.status }) + '\n');
    }
  });
  process.stdout.write(JSON.stringify({ ready: true }) + '\n');
}
main().catch((err) => { process.stderr.write(String(err?.stack ?? err) + '\n'); process.exit(1); });
