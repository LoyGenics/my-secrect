/**
 * Sharing API client + session (specs/sharing-protocol.md). Import this file
 * directly — it is deliberately not re-exported from ./index.
 *
 *  - SharingApiClient: thin HTTP client for /v1/identity-key and /v1/shares.
 *    Sends public keys, ciphertext and opaque ids only.
 *  - SharingSession: the flows the UIs (desktop/web SharesView, mobile
 *    SharesScreen) and tests/sharing-e2e run. It loads or registers the
 *    user's identity, keeps the verified-contacts PinStore, and never uses a
 *    server-provided public key unless it equals the pinned one.
 */
import { ApiError } from './index';
import type { ApiClientConfig } from './index';
import type { VaultItem } from '../../core/src/types';
import { toBase64 } from '../../crypto-adapters/src/index';
import {
  IdentityError,
  KeyChangedError,
  KeyNotVerifiedError,
  PinStore,
  ShareContentError,
  ShareCryptoError,
  decryptIdentity,
  decryptOwnerMetadata,
  decryptShareRecord,
  encryptIdentity,
  encryptOwnerMetadata,
  encryptShareRecord,
  fingerprint,
  fingerprintOf,
  generateIdentityKeyPair,
  mergeSharedEdit,
  newShareId,
  verifyShareKey,
  wipeIdentity,
  type IdentityKeyPair,
  type KeyValueStore,
  type PinState,
  type PinnedKey,
  type SharePermission,
  type ShareStatus,
  type VaultCipher,
} from '../../core/src/sharing';

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface IdentityKeyRecord {
  user_id: string;
  public_key: string;
  encrypted_secret_key: string;
  created_at: string;
}

export interface ContactKey {
  user_id: string;
  email: string;
  public_key: string;
}

export interface ShareParty {
  id: string;
  email: string;
}

export interface ShareSummary {
  id: string;
  role: 'owner' | 'recipient';
  owner: ShareParty;
  recipient: ShareParty;
  permission: SharePermission;
  status: ShareStatus;
  expires_at: string | null;
  expired: boolean;
  revision: number;
  last_writer_id: string | null;
  owner_public_key: string;
  recipient_public_key: string;
  /** Owner only; null for the recipient. */
  encrypted_owner_metadata: string | null;
  created_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

export interface ShareRecordResponse {
  share_id: string;
  revision: number;
  last_writer_id: string | null;
  encrypted_item_key: string | null;
  /** null while the share is pending for the recipient (key exchange only). */
  encrypted_payload: string | null;
}

export interface CreateShareRequest {
  id: string;
  recipient_id: string;
  recipient_public_key: string;
  permission: SharePermission;
  expires_at: string | null;
  encrypted_payload: string;
  encrypted_item_key: string;
  encrypted_owner_metadata: string;
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

export class SharingApiClient {
  private readonly baseUrl: string;
  private readonly getToken: () => Promise<string | null>;

  constructor(cfg: ApiClientConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.getToken = cfg.getToken;
  }

  /** Bearer token when present, ApiError on non-2xx, empty body (204) → undefined.
   *  Request bodies are never logged. */
  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.getToken();
    const res = await fetch(this.baseUrl + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      throw new ApiError(res.status, path, body);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async orNull<T>(p: Promise<T>): Promise<T | null> {
    try {
      return await p;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  async getIdentityKey(): Promise<IdentityKeyRecord | null> {
    const res = await this.orNull(this.req<{ identity_key: IdentityKeyRecord }>('/v1/identity-key'));
    return res?.identity_key ?? null;
  }

  /** Write-once registration. Needs a fresh step-up (403 step_up_required). */
  async registerIdentityKey(publicKey: string, encryptedSecretKey: string): Promise<IdentityKeyRecord> {
    const res = await this.req<{ identity_key: IdentityKeyRecord }>('/v1/identity-key', {
      method: 'PUT',
      body: JSON.stringify({ public_key: publicKey, encrypted_secret_key: encryptedSecretKey }),
    });
    return res.identity_key;
  }

  /** Replace the identity (lost vault key, suspected compromise). Needs a
   *  fresh step-up. The server revokes every share the account is part of;
   *  contacts who pinned the old key see a key change. */
  async rotateIdentityKey(publicKey: string, encryptedSecretKey: string): Promise<{ identity_key: IdentityKeyRecord; revoked_shares: number }> {
    return this.req('/v1/identity-key/rotate', {
      method: 'POST',
      body: JSON.stringify({ public_key: publicKey, encrypted_secret_key: encryptedSecretKey }),
    });
  }

  /** Public key of the active account with this email, or null. The email
   *  goes in the request body, never the URL. */
  lookup(email: string): Promise<ContactKey | null> {
    return this.orNull(this.req<ContactKey>('/v1/identity-keys/lookup', { method: 'POST', body: JSON.stringify({ email }) }));
  }

  async listShares(): Promise<ShareSummary[]> {
    return (await this.req<{ shares: ShareSummary[] }>('/v1/shares')).shares;
  }

  async createShare(body: CreateShareRequest): Promise<ShareSummary> {
    return (await this.req<{ share: ShareSummary }>('/v1/shares', { method: 'POST', body: JSON.stringify(body) })).share;
  }

  async getRecord(shareId: string): Promise<ShareRecordResponse> {
    return (await this.req<{ record: ShareRecordResponse }>(`/v1/shares/${encodeURIComponent(shareId)}/record`)).record;
  }

  async putRecord(shareId: string, body: { base_revision: number; encrypted_payload: string; encrypted_item_key: string }): Promise<ShareRecordResponse> {
    return (await this.req<{ record: ShareRecordResponse }>(`/v1/shares/${encodeURIComponent(shareId)}/record`, { method: 'PUT', body: JSON.stringify(body) })).record;
  }

  async accept(shareId: string, ownerPublicKey: string): Promise<ShareSummary> {
    return (await this.req<{ share: ShareSummary }>(`/v1/shares/${encodeURIComponent(shareId)}/accept`, {
      method: 'POST',
      body: JSON.stringify({ owner_public_key: ownerPublicKey }),
    })).share;
  }

  async revoke(shareId: string): Promise<void> {
    await this.req<void>(`/v1/shares/${encodeURIComponent(shareId)}`, { method: 'DELETE' });
  }
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

/** What the UI may offer for a share. Mirrors the server rules
 *  (specs/sharing-protocol.md §6); the server stays authoritative. */
export function shareActions(share: ShareSummary): { canAccept: boolean; canOpen: boolean; canEdit: boolean; canRevoke: boolean } {
  const live = share.status !== 'revoked' && !share.expired;
  const owner = share.role === 'owner';
  return {
    canAccept: live && !owner && share.status === 'pending',
    canOpen: live && (owner || share.status === 'active'),
    canEdit: live && (owner || (share.status === 'active' && share.permission === 'write')),
    canRevoke: share.status !== 'revoked',
  };
}

export type ShareErrorKind =
  | 'not_verified' | 'key_changed' | 'relabeled' | 'crypto' | 'identity' | 'invalid_content' | 'step_up'
  | 'revoked' | 'expired' | 'not_active' | 'read_only' | 'conflict' | 'unauthorized' | 'other';

const API_ERROR_KINDS: Record<string, ShareErrorKind> = {
  share_revoked: 'revoked',
  share_expired: 'expired',
  share_not_active: 'not_active',
  write_not_permitted: 'read_only',
  revision_conflict: 'conflict',
  step_up_required: 'step_up',
};

/** Map any sharing failure to a kind the UIs translate. `detail` is safe to
 *  show (error codes / messages, never key material). */
export function classifyShareError(e: unknown): { kind: ShareErrorKind; detail: string } {
  if (e instanceof KeyNotVerifiedError) return { kind: 'not_verified', detail: e.message };
  if (e instanceof KeyChangedError) return { kind: e.reason === 'email' ? 'relabeled' : 'key_changed', detail: e.message };
  if (e instanceof ShareContentError) return { kind: 'invalid_content', detail: e.problems.join('; ') };
  if (e instanceof ShareCryptoError) return { kind: 'crypto', detail: e.message };
  if (e instanceof IdentityError) return { kind: 'identity', detail: e.message };
  if (e instanceof ApiError) {
    if (e.status === 401) return { kind: 'unauthorized', detail: '401' };
    const code = /"error":"([a-z_]+)"/.exec(e.message)?.[1];
    const kind = code ? API_ERROR_KINDS[code] : undefined;
    return { kind: kind ?? 'other', detail: code ? `${e.status} ${code}` : String(e.status) };
  }
  return { kind: 'other', detail: e instanceof Error ? e.message : String(e) };
}

/** The other party of a share, seen from `share.role`. */
export function sharePeer(share: ShareSummary): { user: ShareParty; publicKey: string } {
  return share.role === 'owner'
    ? { user: share.recipient, publicKey: share.recipient_public_key }
    : { user: share.owner, publicKey: share.owner_public_key };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** The owner's vault items, for "Save to my vault" / "Send latest version". */
export interface VaultItemsAccess {
  find(id: string): VaultItem | undefined;
  save(item: VaultItem): Promise<void>;
}

export interface SharingSessionOptions {
  api: SharingApiClient;
  /** encryptWithVaultKey / decryptWithVaultKey of the unlocked vault. */
  vault: VaultCipher;
  /** Where this device keeps its (encrypted) verified contacts. */
  pinStorage: KeyValueStore;
  items?: VaultItemsAccess;
}

export interface ContactView extends ContactKey {
  fingerprint: string;
  pinState: PinState;
  /** Set when pinState is 'changed' / 'relabeled': what was verified before. */
  pinnedFingerprint?: string;
  pinnedEmail?: string;
}

/** The other party of a share as the UI may show it. `email` is the PINNED
 *  email when the peer is verified; otherwise it is only what the server
 *  says (`state` tells which). Never show `serverEmail` as verified. */
export interface PeerView {
  userId: string;
  email: string;
  serverEmail: string;
  state: PinState;
  pinnedEmail?: string;
  pinnedFingerprint?: string;
}

export interface OpenedShare {
  /** The share this revision was decrypted from (saveToVault checks it). */
  shareId: string;
  item: VaultItem;
  revision: number;
  lastWriter: 'owner' | 'recipient' | null;
}

/** Load this account's identity, or register a fresh one (write-once). A
 *  device that loses the registration race discards its key pair and loads
 *  the winner's. */
async function loadOrCreateIdentity(api: SharingApiClient, vault: VaultCipher): Promise<{ identity: IdentityKeyPair; userId: string }> {
  const existing = await api.getIdentityKey();
  if (existing) {
    return { identity: await decryptIdentity(existing.encrypted_secret_key, existing.public_key, vault), userId: existing.user_id };
  }
  const fresh = await generateIdentityKeyPair();
  try {
    const registered = await api.registerIdentityKey(toBase64(fresh.publicKey), await encryptIdentity(fresh, vault));
    if (registered.public_key !== toBase64(fresh.publicKey)) throw new IdentityError('the server registered a different identity key');
    return { identity: fresh, userId: registered.user_id };
  } catch (e) {
    wipeIdentity(fresh);
    if (!(e instanceof ApiError && e.status === 409)) throw e;
    const winner = await api.getIdentityKey();
    if (!winner) throw new IdentityError('identity registration conflicted, but no identity is registered');
    return { identity: await decryptIdentity(winner.encrypted_secret_key, winner.public_key, vault), userId: winner.user_id };
  }
}

export class SharingSession {
  private constructor(
    private readonly api: SharingApiClient,
    private readonly vault: VaultCipher,
    private readonly identity: IdentityKeyPair,
    readonly userId: string,
    private readonly pins: PinStore,
    private readonly items: VaultItemsAccess | undefined,
  ) {}

  /** Requires an unlocked vault and a signed-in account. Registering a
   *  first identity needs a fresh step-up (ApiError 403 step_up_required:
   *  verify, then call start again). */
  static async start(opts: SharingSessionOptions): Promise<SharingSession> {
    const { identity, userId } = await loadOrCreateIdentity(opts.api, opts.vault);
    return SharingSession.open(opts, identity, userId);
  }

  /**
   * Replace this account's identity with a fresh key pair (e.g. this
   * device's vault cannot open the old one, or it may be compromised).
   * Needs a fresh step-up. The server revokes every share the account is
   * part of, and every contact who pinned the old key sees a key change.
   */
  static async resetIdentity(opts: SharingSessionOptions): Promise<SharingSession> {
    const fresh = await generateIdentityKeyPair();
    try {
      const res = await opts.api.rotateIdentityKey(toBase64(fresh.publicKey), await encryptIdentity(fresh, opts.vault));
      if (res.identity_key.public_key !== toBase64(fresh.publicKey)) throw new IdentityError('the server registered a different identity key');
      return SharingSession.open(opts, fresh, res.identity_key.user_id);
    } catch (e) {
      wipeIdentity(fresh);
      throw e;
    }
  }

  private static async open(opts: SharingSessionOptions, identity: IdentityKeyPair, userId: string): Promise<SharingSession> {
    try {
      const pins = await PinStore.open(opts.pinStorage, userId, opts.vault);
      return new SharingSession(opts.api, opts.vault, identity, userId, pins, opts.items);
    } catch (e) {
      wipeIdentity(identity);
      throw e;
    }
  }

  /** Zero-fill the identity secret key. The session is unusable afterwards. */
  close(): void {
    wipeIdentity(this.identity);
  }

  get publicKey(): string {
    return toBase64(this.identity.publicKey);
  }

  /** Derived from the locally decrypted key pair, never from the server. */
  myFingerprint(): Promise<string> {
    return fingerprint(this.identity.publicKey);
  }

  verifiedContacts(): PinnedKey[] {
    return this.pins.list();
  }

  async lookupContact(email: string): Promise<ContactView | null> {
    const contact = await this.api.lookup(email.trim());
    if (!contact) return null;
    const pinState = this.pins.state(contact.user_id, contact.public_key, contact.email);
    const pinned = pinState === 'changed' || pinState === 'relabeled' ? this.pins.get(contact.user_id) : undefined;
    return {
      ...contact,
      fingerprint: await fingerprintOf(contact.public_key),
      pinState,
      pinnedFingerprint: pinned?.fingerprint,
      pinnedEmail: pinned?.email,
    };
  }

  /** Call ONLY after the user confirmed the fingerprint out of band. */
  async verifyContact(contact: { user_id: string; email: string; public_key: string }): Promise<PinnedKey> {
    if (contact.user_id === this.userId) throw new IdentityError('you cannot verify your own key as a contact');
    return this.pins.pin(contact);
  }

  /** Explicit re-verification path after a key change. */
  forgetContact(userId: string): Promise<void> {
    return this.pins.forget(userId);
  }

  /** Who the other party is, as far as THIS device verified it. */
  peerView(share: ShareSummary): PeerView {
    const peer = sharePeer(share);
    const state = this.pins.state(peer.user.id, peer.publicKey, peer.user.email);
    const pinned = this.pins.get(peer.user.id);
    return {
      userId: peer.user.id,
      email: state === 'verified' && pinned ? pinned.email : peer.user.email,
      serverEmail: peer.user.email,
      state,
      pinnedEmail: pinned?.email,
      pinnedFingerprint: pinned?.fingerprint,
    };
  }

  listShares(): Promise<ShareSummary[]> {
    return this.api.listShares();
  }

  /** Create a pending share of `item` for a VERIFIED contact. */
  async shareItem(args: { item: VaultItem; contact: ContactKey; permission: SharePermission; expiresAt: string | null }): Promise<ShareSummary> {
    if (args.contact.user_id === this.userId) throw new IdentityError('you cannot share with yourself');
    const peerPublicKey = await this.pins.requireVerified(args.contact.user_id, args.contact.public_key, args.contact.email);
    const id = await newShareId();
    const record = await encryptShareRecord(args.item, { shareId: id, revision: 1, self: this.identity, peerPublicKey });
    return this.api.createShare({
      id,
      recipient_id: args.contact.user_id,
      recipient_public_key: args.contact.public_key,
      permission: args.permission,
      expires_at: args.expiresAt,
      ...record,
      encrypted_owner_metadata: await encryptOwnerMetadata(id, args.item.id, this.vault),
    });
  }

  /** Key-exchange check for a pending incoming share: owner key and email
   *  pinned and equal to the share's, and the wrapped Share Key opens with
   *  that key and is bound to this share id + revision. */
  async verifyIncoming(share: ShareSummary): Promise<void> {
    if (share.role !== 'recipient') throw new IdentityError('only the recipient verifies an incoming share');
    const peer = await this.peerKey(share);
    const record = await this.api.getRecord(share.id);
    if (!record.encrypted_item_key) throw new ShareCryptoError('the share has no wrapped key');
    await verifyShareKey(record.encrypted_item_key, { shareId: share.id, revision: record.revision, self: this.identity, peerPublicKey: peer });
  }

  /** Accept only after the key exchange verified. Never activates otherwise. */
  async acceptShare(share: ShareSummary): Promise<ShareSummary> {
    await this.verifyIncoming(share);
    return this.api.accept(share.id, share.owner_public_key);
  }

  async openShare(share: ShareSummary): Promise<OpenedShare> {
    const peer = await this.peerKey(share);
    const record = await this.api.getRecord(share.id);
    if (!record.encrypted_payload || !record.encrypted_item_key) throw new ShareCryptoError('this share is not active yet');
    const item = await decryptShareRecord(
      { encrypted_payload: record.encrypted_payload, encrypted_item_key: record.encrypted_item_key },
      { shareId: share.id, revision: record.revision, self: this.identity, peerPublicKey: peer },
    );
    let lastWriter: OpenedShare['lastWriter'] = null;
    if (record.last_writer_id === share.owner.id) lastWriter = 'owner';
    else if (record.last_writer_id === share.recipient.id) lastWriter = 'recipient';
    return { shareId: share.id, item, revision: record.revision, lastWriter };
  }

  /** Write revision baseRevision + 1 with a fresh Share Key. 409 (ApiError)
   *  when someone wrote in between; 403 when not permitted. */
  async writeShare(share: ShareSummary, item: VaultItem, baseRevision: number): Promise<number> {
    const peer = await this.peerKey(share);
    const record = await encryptShareRecord(item, { shareId: share.id, revision: baseRevision + 1, self: this.identity, peerPublicKey: peer });
    return (await this.api.putRecord(share.id, { base_revision: baseRevision, ...record })).revision;
  }

  revokeShare(share: ShareSummary): Promise<void> {
    return this.api.revoke(share.id);
  }

  /** Owner only: the vault item this share was made from. */
  async sourceItemId(share: ShareSummary): Promise<string> {
    if (share.role !== 'owner' || !share.encrypted_owner_metadata) throw new ShareCryptoError('only the owner knows the source item');
    return (await decryptOwnerMetadata(share.encrypted_owner_metadata, share.id, this.vault)).source_item_id;
  }

  /**
   * Owner: copy the title/fields/tags of the revision the owner REVIEWED
   * (the OpenedShare they were shown) into the vault item. Nothing is
   * re-fetched, so a revision written after the review is never saved
   * unseen. The merged item must pass schema validation (ShareContentError).
   */
  async saveToVault(share: ShareSummary, reviewed: OpenedShare): Promise<VaultItem> {
    if (share.role !== 'owner') throw new ShareCryptoError('only the owner saves a share into their vault');
    if (reviewed.shareId !== share.id) throw new ShareCryptoError('the reviewed revision belongs to another share');
    const items = this.requireItems();
    const source = items.find(await this.sourceItemId(share));
    if (!source || source.deleted_at) throw new Error('the shared item is no longer in your vault');
    const merged = mergeSharedEdit(source, reviewed.item);
    await items.save(merged);
    return merged;
  }

  /** Owner: publish the vault's current version as a new revision. */
  async sendLatestVersion(share: ShareSummary): Promise<number> {
    const items = this.requireItems();
    const source = items.find(await this.sourceItemId(share));
    if (!source || source.deleted_at) throw new Error('the shared item is no longer in your vault');
    const current = await this.api.getRecord(share.id);
    return this.writeShare(share, source, current.revision);
  }

  private requireItems(): VaultItemsAccess {
    if (!this.items) throw new Error('vault items are not available in this session');
    return this.items;
  }

  /** The peer's PINNED key, after checking this share was made under our
   *  own current identity and the server's peer key AND email equal the pin. */
  private async peerKey(share: ShareSummary): Promise<Uint8Array> {
    const ownKey = share.role === 'owner' ? share.owner_public_key : share.recipient_public_key;
    if (ownKey !== this.publicKey) throw new IdentityError('this share was made for a different identity key');
    const peer = sharePeer(share);
    return this.pins.requireVerified(peer.user.id, peer.publicKey, peer.user.email);
  }
}
