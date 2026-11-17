/**
 * Sharing v1 — client-side crypto for end-to-end encrypted item shares.
 * Protocol, threat model and limits: specs/sharing-protocol.md. NOT audited.
 *
 *  - Identity: one X25519 key pair per user (`crypto_box_keypair`). The
 *    secret key leaves this module only encrypted under the caller's Vault
 *    Key (`encryptIdentity`); every device of the user opens it with its
 *    own copy of the Vault Key (`decryptIdentity`).
 *  - Verification: a peer's public key is trusted only after its
 *    fingerprint was compared out of band and pinned (`PinStore`). Every
 *    operation takes the PINNED key; a server-provided key is only ever
 *    compared with the pin (KeyNotVerifiedError / KeyChangedError).
 *  - Records: each revision has a fresh 32-byte Share Key. The item is
 *    XChaCha20-Poly1305 encrypted with associated data binding the share id
 *    and revision; the Share Key is wrapped with `crypto_box_easy` for the
 *    pair (authenticated: a box only opens under the pinned peer key),
 *    together with SHA-256 of that associated data, so a wrap only verifies
 *    for the share and revision it was made for (format v2).
 *  - Content: every item that is encrypted into a share or merged back into
 *    a vault must pass packages/schemas validateItemSchema (known type,
 *    supported version, required fields, never a FORBIDDEN_FIELDS entry).
 *
 * Everything fails closed with a typed error. libsodium is called directly
 * (only reviewed constructions); crypto-adapters is not modified.
 */
import sodium from 'libsodium-wrappers-sumo';
import { fromBase64, sodiumReady, toBase64 } from '../../crypto-adapters/src/index';
// item-types directly: packages/schemas has no package.json, so Node loads it as
// CommonJS and cannot see names re-exported through its index (export *).
import { validateItemSchema } from '../../schemas/src/item-types';
import { isSupportedSchemaVersion, type VaultItem } from './types';

export type SharePermission = 'read' | 'write';
export type ShareStatus = 'pending' | 'active' | 'revoked';

/** The libsodium members this module uses. The shared .d.ts in
 *  crypto-adapters lists only what that package calls, so this file
 *  declares its own view; the tests exercise every member at runtime. */
interface SharingSodium {
  crypto_box_keypair(): { publicKey: Uint8Array; privateKey: Uint8Array };
  crypto_box_easy(message: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, privateKey: Uint8Array): Uint8Array;
  crypto_box_open_easy(ciphertext: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, privateKey: Uint8Array): Uint8Array;
  crypto_scalarmult_base(privateKey: Uint8Array): Uint8Array;
  crypto_generichash(hashLength: number, message: Uint8Array, key: Uint8Array | null): Uint8Array;
  crypto_hash_sha256(message: Uint8Array): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_encrypt(message: Uint8Array, ad: Uint8Array | null, secretNonce: null, nonce: Uint8Array, key: Uint8Array): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_decrypt(secretNonce: null, ciphertext: Uint8Array, ad: Uint8Array | null, nonce: Uint8Array, key: Uint8Array): Uint8Array;
  randombytes_buf(length: number): Uint8Array;
  memcmp(a: Uint8Array, b: Uint8Array): boolean;
  memzero(bytes: Uint8Array): void;
  from_string(text: string): Uint8Array;
  to_string(bytes: Uint8Array): string;
}
const na = sodium as unknown as SharingSodium;

export const KEY_BYTES = 32;
const NONCE_BYTES = 24; // crypto_box_NONCEBYTES == XChaCha20-Poly1305 NPUBBYTES == 24
const MAC_BYTES = 16;
const BINDING_BYTES = 32; // SHA-256 of the record associated data
/** nonce (24) || crypto_box_easy(Share Key (32) || SHA-256(record AD) (32)) (+16 MAC) = 104. */
export const WRAPPED_SHARE_KEY_BYTES = NONCE_BYTES + KEY_BYTES + BINDING_BYTES + MAC_BYTES;

const IDENTITY_KIND = 'my-secrect.sharing.identity.v1';
const PINS_KIND = 'my-secrect.sharing.pins.v1';
const OWNER_METADATA_KIND = 'my-secrect.sharing.owner-metadata.v1';
const FINGERPRINT_DOMAIN = 'my-secrect:sharing:fingerprint:v1';
const RECORD_AD_PREFIX = 'my-secrect:share-record:v2:';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Authentication or format failure: tampered, wrong recipient, moved record. */
export class ShareCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareCryptoError';
  }
}

/** This device cannot use the sharing identity (wrong vault, tampered, mismatch). */
export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

/** The peer's key has not been verified (pinned) on this device. */
export class KeyNotVerifiedError extends Error {
  constructor(readonly userId: string, readonly presentedFingerprint: string) {
    super('this contact’s key has not been verified on this device');
    this.name = 'KeyNotVerifiedError';
  }
}

/** The server presented a key — or, for the same key, an email — that
 *  differs from what was pinned. Both mean: do not trust, block, warn. */
export class KeyChangedError extends Error {
  constructor(
    readonly userId: string,
    readonly pinnedFingerprint: string,
    readonly presentedFingerprint: string,
    readonly reason: 'key' | 'email' = 'key',
    readonly pinnedEmail?: string,
    readonly presentedEmail?: string,
  ) {
    super(reason === 'key'
      ? 'this contact’s key changed since you verified it — possible server attack'
      : 'the server now labels this verified contact with a different email — possible server attack');
    this.name = 'KeyChangedError';
  }
}

/** Item content that must not be shared or stored (unknown type, missing
 *  required field, forbidden field such as a CVV or PIN). */
export class ShareContentError extends Error {
  constructor(readonly problems: string[]) {
    super(`item cannot be shared or saved: ${problems.join('; ')}`);
    this.name = 'ShareContentError';
  }
}

/** packages/schemas validation of an item about to be encrypted into a
 *  share or written into a vault. Throws ShareContentError. */
export function assertValidItemContent(item: VaultItem): void {
  const problems = validateItemSchema(item.type, item.schema_version, item.fields ?? {});
  if (problems.length > 0) throw new ShareContentError(problems);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Vault-Key string encryption exposed by apps/{desktop,mobile}/src/vault.ts.
 *  `decrypt` may throw (desktop) or return null (mobile) on failure. */
export interface VaultCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(encoded: string): Promise<string | null>;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Base64 → bytes of exactly `length` bytes, or throws `onError`. */
function decodeExact(value: unknown, length: number, onError: () => Error): Uint8Array {
  if (typeof value !== 'string') throw onError();
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(value);
  } catch {
    throw onError();
  }
  if (bytes.length !== length) throw onError();
  return bytes;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && na.memcmp(a, b);
}

async function tryDecrypt(vault: VaultCipher, encoded: string): Promise<string | null> {
  try {
    return await vault.decrypt(encoded);
  } catch {
    return null;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Client-chosen share id (UUID v4 from libsodium's CSPRNG). It is bound
 *  into every record's associated data, so it must exist before encryption. */
export async function newShareId(): Promise<string> {
  await sodiumReady;
  const b = na.randombytes_buf(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Identity key pair
// ---------------------------------------------------------------------------

export interface IdentityKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export async function generateIdentityKeyPair(): Promise<IdentityKeyPair> {
  await sodiumReady;
  const kp = na.crypto_box_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

/** Zero-fill the secret key (on lock / unmount). */
export function wipeIdentity(identity: IdentityKeyPair | null | undefined): void {
  identity?.secretKey.fill(0);
}

/** The opaque `encrypted_secret_key` uploaded next to the public key. Only a
 *  holder of the same Vault Key (the user's own devices) can open it. */
export async function encryptIdentity(identity: IdentityKeyPair, vault: VaultCipher): Promise<string> {
  return vault.encrypt(JSON.stringify({
    kind: IDENTITY_KIND,
    public_key: toBase64(identity.publicKey),
    secret_key: toBase64(identity.secretKey),
  }));
}

/**
 * Open the identity registered on the server. Fails closed unless the
 * ciphertext opens under this device's Vault Key, has the identity `kind`,
 * and its secret key derives exactly the public key inside it AND the
 * public key the server registered.
 */
export async function decryptIdentity(encryptedSecretKey: string, registeredPublicKey: string, vault: VaultCipher): Promise<IdentityKeyPair> {
  await sodiumReady;
  const plaintext = await tryDecrypt(vault, encryptedSecretKey);
  if (plaintext === null) {
    throw new IdentityError('this device’s vault cannot open your sharing identity (it was created with a different vault key); restore this device from your vault backup');
  }
  const parsed = parseJson(plaintext);
  const malformed = () => new IdentityError('the stored sharing identity is malformed');
  if (!isRecord(parsed) || parsed.kind !== IDENTITY_KIND) throw malformed();
  const secretKey = decodeExact(parsed.secret_key, KEY_BYTES, malformed);
  const innerPublic = decodeExact(parsed.public_key, KEY_BYTES, malformed);
  const registered = decodeExact(registeredPublicKey, KEY_BYTES, malformed);
  const derived = na.crypto_scalarmult_base(secretKey);
  if (!bytesEqual(derived, innerPublic) || !bytesEqual(derived, registered)) {
    secretKey.fill(0);
    throw new IdentityError('the sharing identity does not match the public key registered for your account');
  }
  return { publicKey: derived, secretKey };
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

/**
 * 30-digit fingerprint of a public key: BLAKE2b-256 over
 * "my-secrect:sharing:fingerprint:v1" || public_key; six 5-byte big-endian
 * slices, each mod 100000, as six groups of five digits (≈ 99.7 bits).
 */
export async function fingerprint(publicKey: Uint8Array): Promise<string> {
  await sodiumReady;
  if (publicKey.length !== KEY_BYTES) throw new ShareCryptoError('a public key is 32 bytes');
  const hash = na.crypto_generichash(32, concat(na.from_string(FINGERPRINT_DOMAIN), publicKey), null);
  const groups: string[] = [];
  for (let g = 0; g < 6; g++) {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * 256 + hash[g * 5 + i];
    groups.push(String(v % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

export async function fingerprintOf(publicKeyB64: string): Promise<string> {
  return fingerprint(decodeExact(publicKeyB64, KEY_BYTES, () => new ShareCryptoError('malformed public key')));
}

// ---------------------------------------------------------------------------
// Pinned (verified) contact keys — local to this device
// ---------------------------------------------------------------------------

export interface PinnedKey {
  user_id: string;
  email: string;
  public_key: string; // base64, 32 bytes
  fingerprint: string;
  verified_at: string; // ISO 8601
}

/** localStorage / AsyncStorage shape (sync or async). */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

/** 'changed' = different key than pinned; 'relabeled' = pinned key, but the
 *  server now shows a different email for it. Both block every action. */
export type PinState = 'verified' | 'unverified' | 'changed' | 'relabeled';

/** Storage key of one account's pins on this device. */
export function pinStorageKey(ownUserId: string): string {
  return `${PINS_KIND}:${ownUserId}`;
}

/**
 * Verified contact keys on this device, persisted encrypted under the Vault
 * Key (AEAD integrity at rest) and namespaced per account. An unreadable or
 * foreign pin file fails closed (`open` throws); `reset` clears it so the
 * user can verify contacts again.
 */
export class PinStore {
  private constructor(
    private readonly store: KeyValueStore,
    private readonly ownUserId: string,
    private readonly vault: VaultCipher,
    private readonly pins: Map<string, PinnedKey>,
  ) {}

  static async open(store: KeyValueStore, ownUserId: string, vault: VaultCipher): Promise<PinStore> {
    const raw = await store.getItem(pinStorageKey(ownUserId));
    const pins = new Map<string, PinnedKey>();
    if (raw) {
      const plaintext = await tryDecrypt(vault, raw);
      const parsed = plaintext === null ? null : parseJson(plaintext);
      if (!isRecord(parsed) || parsed.kind !== PINS_KIND || parsed.owner !== ownUserId || !Array.isArray(parsed.pins)) {
        throw new IdentityError('verified contacts on this device cannot be read (tampered, or saved by another vault)');
      }
      for (const p of parsed.pins) {
        if (isRecord(p) && typeof p.user_id === 'string' && typeof p.email === 'string' && typeof p.public_key === 'string' && typeof p.fingerprint === 'string') {
          pins.set(p.user_id, p as unknown as PinnedKey);
        }
      }
    }
    return new PinStore(store, ownUserId, vault, pins);
  }

  static async reset(store: KeyValueStore, ownUserId: string): Promise<void> {
    await store.removeItem(pinStorageKey(ownUserId));
  }

  get(userId: string): PinnedKey | undefined {
    return this.pins.get(userId);
  }

  list(): PinnedKey[] {
    return [...this.pins.values()];
  }

  /** Pin a key — with the email it was verified under — that the user
   *  confirmed out of band. Refuses to overwrite a different pinned key or
   *  email: `forget` it first (explicit re-verification). */
  async pin(entry: { user_id: string; email: string; public_key: string }): Promise<PinnedKey> {
    const fp = await fingerprintOf(entry.public_key);
    const email = normalizeEmail(entry.email);
    const existing = this.pins.get(entry.user_id);
    if (existing && existing.public_key !== entry.public_key) {
      throw new KeyChangedError(entry.user_id, existing.fingerprint, fp, 'key', existing.email, email);
    }
    if (existing && existing.email !== email) {
      throw new KeyChangedError(entry.user_id, existing.fingerprint, fp, 'email', existing.email, email);
    }
    const pinned: PinnedKey = { user_id: entry.user_id, email, public_key: entry.public_key, fingerprint: fp, verified_at: new Date().toISOString() };
    this.pins.set(entry.user_id, pinned);
    await this.persist();
    return pinned;
  }

  async forget(userId: string): Promise<void> {
    this.pins.delete(userId);
    await this.persist();
  }

  /** Compare what the server presents (key AND email label) with the pin. */
  state(userId: string, presentedPublicKey: string, presentedEmail: string): PinState {
    const pinned = this.pins.get(userId);
    if (!pinned) return 'unverified';
    if (pinned.public_key !== presentedPublicKey) return 'changed';
    return pinned.email === normalizeEmail(presentedEmail) ? 'verified' : 'relabeled';
  }

  /** The PINNED key bytes, if the server-presented key and email equal the
   *  pin. Throws KeyNotVerifiedError / KeyChangedError (reason 'key' or
   *  'email') otherwise. */
  async requireVerified(userId: string, presentedPublicKey: string, presentedEmail: string): Promise<Uint8Array> {
    const presentedFp = await fingerprintOf(presentedPublicKey);
    const pinned = this.pins.get(userId);
    if (!pinned) throw new KeyNotVerifiedError(userId, presentedFp);
    if (pinned.public_key !== presentedPublicKey) {
      throw new KeyChangedError(userId, pinned.fingerprint, presentedFp, 'key', pinned.email, normalizeEmail(presentedEmail));
    }
    if (pinned.email !== normalizeEmail(presentedEmail)) {
      throw new KeyChangedError(userId, pinned.fingerprint, presentedFp, 'email', pinned.email, normalizeEmail(presentedEmail));
    }
    return decodeExact(pinned.public_key, KEY_BYTES, () => new ShareCryptoError('malformed pinned key'));
  }

  private async persist(): Promise<void> {
    const ciphertext = await this.vault.encrypt(JSON.stringify({ kind: PINS_KIND, owner: this.ownUserId, pins: this.list() }));
    await this.store.setItem(pinStorageKey(this.ownUserId), ciphertext);
  }
}

// ---------------------------------------------------------------------------
// Share records
// ---------------------------------------------------------------------------

export interface EncryptedShareRecord {
  encrypted_payload: string;
  encrypted_item_key: string;
}

export interface RecordContext {
  shareId: string;
  revision: number;
  self: IdentityKeyPair;
  /** The peer's PINNED public key (PinStore.requireVerified). */
  peerPublicKey: Uint8Array;
}

function recordAd(shareId: string, revision: number): Uint8Array {
  if (!UUID_V4.test(shareId)) throw new ShareCryptoError('share id must be a lowercase UUID v4');
  if (!Number.isInteger(revision) || revision < 1) throw new ShareCryptoError('revision must be a positive integer');
  return na.from_string(`${RECORD_AD_PREFIX}${shareId}:${revision}`);
}

/** The copy of a vault item that is shared: the owner's private graph
 *  (relations), blobs (attachments), favorite flag and trash state stay out. */
export function toSharedItem(item: VaultItem): VaultItem {
  return {
    id: item.id,
    type: item.type,
    schema_version: item.schema_version,
    title: item.title,
    fields: item.fields,
    tags: item.tags,
    relations: [],
    attachments: [],
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

function isSharedItem(v: unknown): v is VaultItem {
  return isRecord(v)
    && typeof v.id === 'string' && typeof v.type === 'string'
    && isSupportedSchemaVersion(v.schema_version) && typeof v.title === 'string'
    && isRecord(v.fields)
    && Array.isArray(v.tags) && v.tags.every((t) => typeof t === 'string')
    && Array.isArray(v.relations) && v.relations.length === 0
    && Array.isArray(v.attachments) && v.attachments.length === 0
    && typeof v.created_at === 'string' && typeof v.updated_at === 'string';
}

/** Encrypt revision `ctx.revision` of a share with a fresh Share Key. The
 *  item must pass schema validation (ShareContentError otherwise). */
export async function encryptShareRecord(item: VaultItem, ctx: RecordContext): Promise<EncryptedShareRecord> {
  await sodiumReady;
  if (ctx.peerPublicKey.length !== KEY_BYTES) throw new ShareCryptoError('peer public key must be 32 bytes');
  const shared = toSharedItem(item);
  assertValidItemContent(shared);
  const ad = recordAd(ctx.shareId, ctx.revision);
  const shareKey = na.randombytes_buf(KEY_BYTES);
  const boxedMessage = concat(shareKey, na.crypto_hash_sha256(ad));
  try {
    const nonce = na.randombytes_buf(NONCE_BYTES);
    const ciphertext = na.crypto_aead_xchacha20poly1305_ietf_encrypt(na.from_string(JSON.stringify(shared)), ad, null, nonce, shareKey);
    const boxNonce = na.randombytes_buf(NONCE_BYTES);
    const boxed = na.crypto_box_easy(boxedMessage, boxNonce, ctx.peerPublicKey, ctx.self.secretKey);
    return { encrypted_payload: toBase64(concat(nonce, ciphertext)), encrypted_item_key: toBase64(concat(boxNonce, boxed)) };
  } finally {
    na.memzero(shareKey);
    na.memzero(boxedMessage);
  }
}

/** Open a wrapped Share Key with the pinned peer key and check that it is
 *  bound to this share + revision. The caller wipes the returned key. */
async function openShareKey(encryptedItemKey: string, ctx: RecordContext): Promise<Uint8Array> {
  await sodiumReady;
  const ad = recordAd(ctx.shareId, ctx.revision);
  const bytes = decodeExact(encryptedItemKey, WRAPPED_SHARE_KEY_BYTES, () => new ShareCryptoError('wrapped share key is malformed'));
  let opened: Uint8Array;
  try {
    opened = na.crypto_box_open_easy(bytes.subarray(NONCE_BYTES), bytes.subarray(0, NONCE_BYTES), ctx.peerPublicKey, ctx.self.secretKey);
  } catch {
    throw new ShareCryptoError('wrapped share key failed authentication (tampered, or not made for this key pair)');
  }
  try {
    if (opened.length !== KEY_BYTES + BINDING_BYTES) throw new ShareCryptoError('wrapped share key has the wrong length');
    if (!na.memcmp(opened.subarray(KEY_BYTES), na.crypto_hash_sha256(ad))) {
      throw new ShareCryptoError('wrapped share key was made for another share or revision');
    }
    return opened.slice(0, KEY_BYTES);
  } finally {
    na.memzero(opened);
  }
}

/** Key-exchange check before accepting a pending share: the wrap must open
 *  with the PINNED owner key and be bound to this share id + revision.
 *  Nothing is kept. Throws ShareCryptoError. */
export async function verifyShareKey(encryptedItemKey: string, ctx: RecordContext): Promise<void> {
  na.memzero(await openShareKey(encryptedItemKey, ctx));
}

/** Decrypt one revision. Throws ShareCryptoError on any tampering, a wrong
 *  key pair, or a record moved from another share or revision. */
export async function decryptShareRecord(record: EncryptedShareRecord, ctx: RecordContext): Promise<VaultItem> {
  const ad = recordAd(ctx.shareId, ctx.revision);
  const key = await openShareKey(record.encrypted_item_key, ctx);
  try {
    let payload: Uint8Array;
    try {
      payload = fromBase64(record.encrypted_payload);
    } catch {
      throw new ShareCryptoError('shared item ciphertext is malformed');
    }
    if (payload.length < NONCE_BYTES + MAC_BYTES) throw new ShareCryptoError('shared item ciphertext is too short');
    let plaintext: Uint8Array;
    try {
      plaintext = na.crypto_aead_xchacha20poly1305_ietf_decrypt(null, payload.subarray(NONCE_BYTES), ad, payload.subarray(0, NONCE_BYTES), key);
    } catch {
      throw new ShareCryptoError('shared item failed authentication (tampered, or moved from another share or revision)');
    }
    const item = parseJson(na.to_string(plaintext));
    plaintext.fill(0);
    if (!isSharedItem(item)) throw new ShareCryptoError('decrypted share is not a valid item');
    return item;
  } finally {
    na.memzero(key);
  }
}

/** The owner's "Save to my vault": title, fields and tags come from the
 *  share; id, type, relations, attachments and favorite stay the vault's.
 *  The merged item must pass schema validation for the VAULT item's type
 *  (ShareContentError otherwise) — recipient-written content never brings
 *  a forbidden field (CVV, PIN, live OTP) or a malformed item into a vault. */
export function mergeSharedEdit(vaultItem: VaultItem, shared: VaultItem, now: string = new Date().toISOString()): VaultItem {
  const merged = { ...vaultItem, title: shared.title, fields: shared.fields, tags: shared.tags, updated_at: now };
  assertValidItemContent(merged);
  return merged;
}

// ---------------------------------------------------------------------------
// Owner-only metadata (which vault item a share came from)
// ---------------------------------------------------------------------------

export async function encryptOwnerMetadata(shareId: string, sourceItemId: string, vault: VaultCipher): Promise<string> {
  return vault.encrypt(JSON.stringify({ kind: OWNER_METADATA_KIND, share_id: shareId, source_item_id: sourceItemId }));
}

/** Throws ShareCryptoError unless it opens under this Vault Key and names `shareId`. */
export async function decryptOwnerMetadata(encoded: string, shareId: string, vault: VaultCipher): Promise<{ source_item_id: string }> {
  const plaintext = await tryDecrypt(vault, encoded);
  const parsed = plaintext === null ? null : parseJson(plaintext);
  if (!isRecord(parsed) || parsed.kind !== OWNER_METADATA_KIND || parsed.share_id !== shareId || typeof parsed.source_item_id !== 'string') {
    throw new ShareCryptoError('owner metadata for this share cannot be opened');
  }
  return { source_item_id: parsed.source_item_id };
}
