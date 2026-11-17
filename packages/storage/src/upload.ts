/**
 * Client-side chunked encrypted upload / download.
 *
 * Verified by packages/storage/tests/upload.real.test.mts (real libsodium,
 * real SHA-256, in-memory object store) and by tests/media-e2e (real API +
 * real MinIO through the public presigned endpoint).
 *
 *  - Every file gets its own random 32-byte File Key. Each chunk is
 *    encrypted independently with the File Key + a fresh random 24-byte
 *    nonce (XChaCha20-Poly1305 IETF, encryption_version 1, null AD — the
 *    frozen v1 format).
 *  - Because AD is null, the AEAD tag alone cannot tell chunk 2 from chunk 5.
 *    Order / count / truncation / duplication are therefore bound by the
 *    MANIFEST: format version, blob id, total plaintext size, chunk size,
 *    and per chunk: part number, byte range, nonce, ciphertext length and
 *    SHA-256 of the CIPHERTEXT (plus the SHA-256 of the whole plaintext).
 *    The manifest is encrypted + authenticated with the Vault Key, so the
 *    server cannot forge or edit it. Downloads also check the manifest's
 *    blob id equals the requested blob (a server cannot hand back another
 *    blob's manifest) and that the server's part list matches the manifest.
 *  - The manifest carries the file name, MIME type, size, chunk list and the
 *    File Key wrapped with the Vault Key, so any device holding the Vault
 *    Key (a second device restored from the same vault) can decrypt. The
 *    server stores the encrypted manifest opaquely and never sees a File
 *    Key. Thumbnails are separate blobs (apps/desktop/src/utils/media.ts);
 *    manifests written before that may embed one (`thumbnail`, encrypted
 *    with the File Key) and stay readable.
 *  - Streaming, bounded memory. Upload reads plaintext from a ChunkSource
 *    one 1 MiB chunk at a time, twice: pass 1 (prepareUpload) encrypts each
 *    chunk with a fresh random nonce only to record nonce + ciphertext hash
 *    in the manifest, then drops it; pass 2 (runUpload) re-encrypts each
 *    part with its RECORDED nonce — identical ciphertext — checks the hash
 *    against the manifest and PUTs it. If the source changed in between,
 *    the re-encrypted bytes differ, the hash check fails and NOTHING is
 *    sent for that part, so two different ciphertexts under one nonce never
 *    leave the device. Download verifies each part (length, SHA-256 against
 *    the manifest, AEAD tag) before decrypting it and hands plaintext to a
 *    PlaintextSink in order, fetching at most `concurrency` parts ahead.
 *  - Fail closed. A sink gets a chunk only after that chunk verified; if a
 *    later check fails (another chunk, the whole-file hash) the sink is
 *    aborted and the call throws, so callers present nothing until
 *    downloadToSink resolves. downloadFile returns bytes only when
 *    everything verified.
 *  - Chunk size: 1 MiB plaintext per chunk, uploaded as ONE presigned-PUT
 *    part (1 MiB + 16 B tag). The API signs each part's exact size into its
 *    URL; storage refuses any other length. 5,120 parts max (5 GiB).
 *  - Retry and resume. Each part is retried with exponential backoff
 *    (attempts / backoffMs); HTTP 400/401/403/404 are permanent. A failed
 *    upload throws BlobUploadError listing the missing parts. A ResumeState
 *    (blob id, vault id, encrypted manifest — no plaintext, no key) is kept
 *    in a ResumeStore until complete; resumeUpload re-opens the same server
 *    session (fresh URLs, `stored` per part from storage) so only missing
 *    parts are sent, even from a new process.
 *  - Downloads support ranges: `chunkIndexForByteRange` maps a byte range to
 *    chunk indices (video seek).
 */
import sodium from 'libsodium-wrappers-sumo';
import type { CryptoAdapter } from '../../crypto-adapters/src/index';
import { toBase64, fromBase64, sodiumReady, sha256 } from '../../crypto-adapters/src/index';

export const CHUNK_SIZE = 1024 * 1024; // 1 MiB plaintext per chunk
export const MANIFEST_VERSION = 1;

export interface ChunkInfo {
  part_number: number; // 1-based
  byte_start: number; // plaintext offset, inclusive
  byte_end: number; // plaintext offset, exclusive
  nonce_b64: string;
  ciphertext_size: number;
  ciphertext_sha256_b64: string; // SHA-256 of the ciphertext bytes
}

/**
 * The per-file key, wrapped with the Vault Key (AEAD via the crypto
 * adapter's wrapKey — XChaCha20-Poly1305, fresh nonce). The SERVER stores
 * this WRAPPED form only, inside the Vault-Key-encrypted manifest: it
 * never sees the plaintext File Key. A manifest without this field is
 * NOT downloadable — the chunks alone are useless without the File Key —
 * so uploads must attach it (see attachWrappedFileKey) and Complete
 * refuses blobs whose stored manifest is missing.
 */
export interface WrappedFileKey {
  nonce_b64: string;
  wrapped_b64: string; // AEAD ciphertext of the 32-byte File Key (+ tag)
  encryption_version: number; // 1
}

/** Legacy: a thumbnail embedded in the manifest, encrypted with the File Key. New thumbnails are their own blobs. */
export interface EncryptedThumbnail {
  mime_type: string;
  nonce_b64: string;
  ciphertext_b64: string;
}

export interface BlobManifest {
  format_version: number;
  blob_id: string;
  plaintext_size: number;
  chunk_size: number;
  mime_type: string;
  /** Original file name. Lives only inside the encrypted manifest. */
  file_name?: string;
  chunks: ChunkInfo[];
  /** SHA-256 of the whole plaintext (base64), checked after the last chunk of a download. */
  plaintext_sha256_b64?: string;
  thumbnail?: EncryptedThumbnail;
  /** Wrapped File Key. Optional in the TYPE only so manifests written
   *  before Phase C still parse; requireWrappedFileKey() enforces it
   *  for every new upload / download. */
  wrapped_file_key?: WrappedFileKey;
}

export interface EncryptedManifest {
  nonce_b64: string;
  ciphertext_b64: string; // Vault-Key-encrypted BlobManifest JSON
  encryption_version: number;
}

export interface EncryptedChunk {
  part_number: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

const AEAD_TAG_BYTES = 16;
const NONCE_BYTES = 24;

// libsodium SHA-256 (crypto-adapters), not WebCrypto: Hermes (mobile) has no crypto.subtle.
async function sha256B64(data: Uint8Array): Promise<string> {
  return toBase64(await sha256(data));
}

/** Random RFC 4122 v4 UUID from the adapter's CSPRNG (Hermes has no crypto.randomUUID). */
function uuidV4(crypto: CryptoAdapter): string {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// libsodium's incremental SHA-256 (in the sumo build; the shared d.ts shim
// declares only the members other packages call).
type Sha256State = unknown;
const sodiumHash = sodium as unknown as {
  crypto_hash_sha256_init(): Sha256State;
  crypto_hash_sha256_update(state: Sha256State, message: Uint8Array): void;
  crypto_hash_sha256_final(state: Sha256State): Uint8Array;
};
function sha256Stream() {
  const state = sodiumHash.crypto_hash_sha256_init();
  return {
    update(b: Uint8Array) { sodiumHash.crypto_hash_sha256_update(state, b); },
    digest(): Uint8Array { return sodiumHash.crypto_hash_sha256_final(state); },
  };
}
export function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * XChaCha20-Poly1305 IETF with null AD — exactly libsodiumAdapter.encrypt
 * (encryption_version 1) — with the nonce supplied, so pass 2 of an upload
 * reproduces the ciphertext recorded in the manifest.
 */
function sealChunk(fileKey: Uint8Array, nonce: Uint8Array, plain: Uint8Array): Uint8Array {
  if (nonce.length !== NONCE_BYTES) throw new Error(`nonce must be ${NONCE_BYTES} bytes`);
  return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, null, null, nonce, fileKey);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ---------------------------------------------------------------------------
// Plaintext sources
// ---------------------------------------------------------------------------

/** Random-access plaintext. Uploads read it one chunk at a time and never hold the whole file. */
export interface ChunkSource {
  readonly size: number;
  /** Plaintext bytes [start, end). */
  read(start: number, end: number): Promise<Uint8Array>;
}

export function bytesSource(data: Uint8Array): ChunkSource {
  return { size: data.length, read: async (start, end) => data.subarray(start, end) };
}

/** A browser File / Blob: each read is one slice. */
export function blobSource(blob: Blob): ChunkSource {
  return { size: blob.size, read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()) };
}

async function readRange(source: ChunkSource, start: number, end: number): Promise<Uint8Array> {
  const bytes = await source.read(start, end);
  if (bytes.length !== end - start) throw new Error(`source returned ${bytes.length} bytes for range ${start}-${end} — the file changed or is unreadable`);
  return bytes;
}

/** Split plaintext into 1 MiB chunks (last chunk may be smaller). */
export function splitIntoChunks(data: Uint8Array, chunkSize: number = CHUNK_SIZE): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    chunks.push(data.slice(offset, Math.min(offset + chunkSize, data.length)));
  }
  if (chunks.length === 0) chunks.push(new Uint8Array(0)); // empty file = one empty chunk
  return chunks;
}

/** Encrypt every chunk with the per-file key, all in memory. Returns chunks + manifest. */
export async function encryptChunks(
  data: Uint8Array,
  fileKey: Uint8Array,
  blobId: string,
  mimeType: string,
  crypto: CryptoAdapter,
): Promise<{ chunks: EncryptedChunk[]; manifest: BlobManifest }> {
  const plainChunks = splitIntoChunks(data);
  const chunks: EncryptedChunk[] = [];
  const infos: ChunkInfo[] = [];
  for (let i = 0; i < plainChunks.length; i++) {
    const plain = plainChunks[i];
    const { nonce, ciphertext } = await crypto.encrypt(fileKey, plain);
    chunks.push({ part_number: i + 1, nonce, ciphertext });
    infos.push({
      part_number: i + 1,
      byte_start: i * CHUNK_SIZE,
      byte_end: i * CHUNK_SIZE + plain.length,
      nonce_b64: toBase64(nonce),
      ciphertext_size: ciphertext.length,
      ciphertext_sha256_b64: await sha256B64(ciphertext),
    });
  }
  return {
    chunks,
    manifest: { format_version: MANIFEST_VERSION, blob_id: blobId, plaintext_size: data.length, chunk_size: CHUNK_SIZE, mime_type: mimeType, chunks: infos },
  };
}

/**
 * Pass 1 of an upload: read the source chunk by chunk, encrypt each with a
 * fresh nonce, keep only (nonce, ciphertext length, ciphertext SHA-256) and
 * a running SHA-256 of the plaintext. Memory stays at one chunk.
 */
async function planChunks(source: ChunkSource, fileKey: Uint8Array, crypto: CryptoAdapter): Promise<{ chunks: ChunkInfo[]; plaintextSha256: Uint8Array }> {
  const count = Math.max(1, Math.ceil(source.size / CHUNK_SIZE));
  const hash = sha256Stream();
  const chunks: ChunkInfo[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, source.size);
    const plain = await readRange(source, start, end);
    hash.update(plain);
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const ciphertext = sealChunk(fileKey, nonce, plain);
    chunks.push({ part_number: i + 1, byte_start: start, byte_end: end, nonce_b64: toBase64(nonce), ciphertext_size: ciphertext.length, ciphertext_sha256_b64: await sha256B64(ciphertext) });
  }
  return { chunks, plaintextSha256: hash.digest() };
}

// ---------------------------------------------------------------------------
// File Key + manifest
// ---------------------------------------------------------------------------

/**
 * Wrap the per-file key with the Vault Key. The wrapped form is what
 * goes into the manifest (and therefore, encrypted, onto the server).
 * Uses the adapter's wrapKey (AEAD) — never store or transmit the
 * plaintext File Key.
 */
export async function wrapFileKey(
  fileKey: Uint8Array,
  vaultKey: Uint8Array,
  crypto: CryptoAdapter,
): Promise<WrappedFileKey> {
  const { nonce, wrapped } = await crypto.wrapKey(vaultKey, fileKey);
  return { nonce_b64: toBase64(nonce), wrapped_b64: toBase64(wrapped), encryption_version: 1 };
}

/** Unwrap a manifest's wrapped File Key with the Vault Key. Throws on a bad tag. */
export async function unwrapFileKey(
  wrapped: WrappedFileKey,
  vaultKey: Uint8Array,
  crypto: CryptoAdapter,
): Promise<Uint8Array> {
  return crypto.unwrapKey(vaultKey, fromBase64(wrapped.nonce_b64), fromBase64(wrapped.wrapped_b64));
}

/**
 * Attach the wrapped File Key to a manifest before it is encrypted with
 * buildEncryptedManifest: a manifest uploaded without the wrapped key can
 * never be downloaded.
 */
export async function attachWrappedFileKey(
  manifest: BlobManifest,
  fileKey: Uint8Array,
  vaultKey: Uint8Array,
  crypto: CryptoAdapter,
): Promise<BlobManifest> {
  manifest.wrapped_file_key = await wrapFileKey(fileKey, vaultKey, crypto);
  return manifest;
}

/** Throw unless the manifest carries a wrapped File Key (i.e. downloads are possible). */
export function requireWrappedFileKey(manifest: BlobManifest): WrappedFileKey {
  if (!manifest.wrapped_file_key?.nonce_b64 || !manifest.wrapped_file_key?.wrapped_b64) {
    throw new Error('manifest has no wrapped_file_key — this blob cannot be decrypted on download (pre-Phase C upload?)');
  }
  return manifest.wrapped_file_key;
}

/** Encrypt the manifest itself with the Vault Key (server never sees it). */
export async function buildEncryptedManifest(manifest: BlobManifest, vaultKey: Uint8Array, crypto: CryptoAdapter): Promise<EncryptedManifest> {
  const { nonce, ciphertext } = await crypto.encrypt(vaultKey, new TextEncoder().encode(JSON.stringify(manifest)));
  return { nonce_b64: toBase64(nonce), ciphertext_b64: toBase64(ciphertext), encryption_version: 1 };
}

export async function decryptManifest(enc: EncryptedManifest, vaultKey: Uint8Array, crypto: CryptoAdapter): Promise<BlobManifest> {
  if (enc?.encryption_version !== 1) throw new Error(`unsupported manifest encryption_version ${enc?.encryption_version}`);
  // AEAD failure (wrong key, edited/forged manifest) throws here — never swallowed.
  const plain = await crypto.decrypt(vaultKey, fromBase64(enc.nonce_b64), fromBase64(enc.ciphertext_b64));
  const manifest = JSON.parse(new TextDecoder().decode(plain)) as BlobManifest;
  verifyManifest(manifest);
  return manifest;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function b64Len(b64: string, what: string): number {
  let bytes: Uint8Array;
  try { bytes = fromBase64(b64); } catch { throw new Error(`${what} is not valid base64`); }
  return bytes.length;
}

/**
 * Verify a manifest's shape and internal consistency. Throws on any
 * mismatch: wrong version, non-contiguous / out-of-order chunks, size
 * mismatch, malformed nonce/hash, duplicate nonces. (The per-chunk
 * ciphertext hashes are checked against the real bytes at download time.)
 */
export function verifyManifest(manifest: BlobManifest): void {
  if (!isObj(manifest)) throw new Error('manifest is not an object');
  if (manifest.format_version !== MANIFEST_VERSION) throw new Error(`unsupported manifest version ${manifest.format_version}`);
  if (typeof manifest.blob_id !== 'string' || !manifest.blob_id) throw new Error('manifest has no blob_id');
  if (typeof manifest.mime_type !== 'string') throw new Error('manifest has no mime_type');
  if (!Number.isSafeInteger(manifest.plaintext_size) || manifest.plaintext_size < 0) throw new Error('manifest plaintext_size invalid');
  if (!Number.isSafeInteger(manifest.chunk_size) || manifest.chunk_size < 1) throw new Error('manifest chunk_size invalid');
  if (!Array.isArray(manifest.chunks) || !manifest.chunks.length) throw new Error('manifest has no chunks');
  if (manifest.plaintext_sha256_b64 !== undefined && (typeof manifest.plaintext_sha256_b64 !== 'string' || b64Len(manifest.plaintext_sha256_b64, 'plaintext hash') !== 32)) {
    throw new Error('manifest plaintext_sha256_b64 must be a SHA-256');
  }
  const nonces = new Set<string>();
  let expectedStart = 0;
  for (let i = 0; i < manifest.chunks.length; i++) {
    const c = manifest.chunks[i];
    if (!isObj(c)) throw new Error(`chunk ${i + 1} malformed`);
    if (c.part_number !== i + 1) throw new Error(`chunk out of order at index ${i}`);
    if (c.byte_start !== expectedStart) throw new Error(`chunk ${c.part_number} is not contiguous`);
    if (!Number.isSafeInteger(c.byte_end) || c.byte_end < c.byte_start) throw new Error(`chunk ${c.part_number} has an invalid range`);
    if (c.byte_end <= c.byte_start && manifest.plaintext_size > 0) throw new Error(`chunk ${c.part_number} has an empty range`);
    const len = c.byte_end - c.byte_start;
    if (len > manifest.chunk_size) throw new Error(`chunk ${c.part_number} exceeds chunk_size`);
    if (i < manifest.chunks.length - 1 && len !== manifest.chunk_size) throw new Error(`chunk ${c.part_number} is short but not last`);
    if (c.ciphertext_size !== len + AEAD_TAG_BYTES) throw new Error(`chunk ${c.part_number} ciphertext_size does not match its range`);
    if (typeof c.nonce_b64 !== 'string' || b64Len(c.nonce_b64, `chunk ${c.part_number} nonce`) !== NONCE_BYTES) throw new Error(`chunk ${c.part_number} nonce must be ${NONCE_BYTES} bytes`);
    if (nonces.has(c.nonce_b64)) throw new Error(`chunk ${c.part_number} reuses a nonce`);
    nonces.add(c.nonce_b64);
    if (typeof c.ciphertext_sha256_b64 !== 'string' || b64Len(c.ciphertext_sha256_b64, `chunk ${c.part_number} hash`) !== 32) throw new Error(`chunk ${c.part_number} hash must be SHA-256`);
    expectedStart = c.byte_end;
  }
  if (expectedStart !== manifest.plaintext_size) throw new Error(`manifest size ${manifest.plaintext_size} does not match chunk ranges (${expectedStart})`);
}

/** Map a plaintext byte range [start, end) to the chunk part numbers needed. */
export function chunkIndexForByteRange(manifest: BlobManifest, start: number, end: number): number[] {
  const parts: number[] = [];
  for (const c of manifest.chunks) {
    if (c.byte_end > start && c.byte_start < end) parts.push(c.part_number);
  }
  return parts;
}

/** Verify ONE downloaded chunk against the authenticated manifest (length, SHA-256), then AEAD-decrypt it. */
async function openChunk(info: ChunkInfo, ciphertext: Uint8Array, fileKey: Uint8Array, crypto: CryptoAdapter): Promise<Uint8Array> {
  if (ciphertext.length !== info.ciphertext_size) throw new Error(`chunk ${info.part_number} size mismatch — possible truncation (got ${ciphertext.length} bytes, manifest says ${info.ciphertext_size})`);
  if (await sha256B64(ciphertext) !== info.ciphertext_sha256_b64) throw new Error(`chunk ${info.part_number} hash mismatch — tampered, reordered or substituted`);
  // AEAD decrypt throws on a bad tag: a tampered chunk is never returned.
  const plain = await crypto.decrypt(fileKey, fromBase64(info.nonce_b64), ciphertext);
  if (plain.length !== info.byte_end - info.byte_start) throw new Error(`chunk ${info.part_number} decrypted to an unexpected length`);
  return plain;
}

/**
 * Decrypt + verify already-downloaded chunks, in order, into the original
 * bytes. Phase 1 verifies EVERY chunk (count, order, length, nonce,
 * SHA-256) against the authenticated manifest; only then does phase 2
 * AEAD-decrypt. Any failure throws — partial plaintext is never returned.
 */
export async function decryptChunks(
  chunks: EncryptedChunk[],
  manifest: BlobManifest,
  fileKey: Uint8Array,
  crypto: CryptoAdapter,
): Promise<Uint8Array> {
  verifyManifest(manifest);
  if (chunks.length !== manifest.chunks.length) throw new Error(`expected ${manifest.chunks.length} chunks, got ${chunks.length} — truncated or padded download`);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const info = manifest.chunks[i];
    if (chunk.part_number !== info.part_number) throw new Error(`chunk ${i + 1} out of order`);
    if (chunk.ciphertext.length !== info.ciphertext_size) throw new Error(`chunk ${info.part_number} size mismatch — possible truncation`);
    if (toBase64(chunk.nonce) !== info.nonce_b64) throw new Error(`chunk ${info.part_number} nonce does not match the manifest`);
    const hash = await sha256B64(chunk.ciphertext);
    if (hash !== info.ciphertext_sha256_b64) throw new Error(`chunk ${info.part_number} hash mismatch — tampered, reordered or substituted`);
  }
  const out = new Uint8Array(manifest.plaintext_size);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const plain = await openChunk(manifest.chunks[i], chunks[i].ciphertext, fileKey, crypto);
    out.set(plain, offset);
    offset += plain.length;
  }
  if (offset !== manifest.plaintext_size) throw new Error('reassembled size does not match manifest');
  return out;
}

// ---------------------------------------------------------------------------
// Resumable upload state
// ---------------------------------------------------------------------------
export const UPLOAD_STATE_KEY_PREFIX = 'my-secrect.upload.v1.';

export interface UploadState {
  blob_id: string;
  total_parts: number;
  uploaded_parts: number[];
  updated_at: string;
}

export class ResumableUpload {
  private uploaded = new Set<number>();
  constructor(
    public readonly blobId: string,
    public readonly totalParts: number,
    uploadedParts: number[] = [],
  ) {
    for (const p of uploadedParts) this.uploaded.add(p);
  }
  markUploaded(partNumber: number): void { this.uploaded.add(partNumber); }
  isUploaded(partNumber: number): boolean { return this.uploaded.has(partNumber); }
  missingParts(): number[] {
    const missing: number[] = [];
    for (let p = 1; p <= this.totalParts; p++) if (!this.uploaded.has(p)) missing.push(p);
    return missing;
  }
  isComplete(): boolean { return this.missingParts().length === 0; }
  progress(): number { return this.totalParts === 0 ? 1 : this.uploaded.size / this.totalParts; }
  toState(): UploadState {
    return { blob_id: this.blobId, total_parts: this.totalParts, uploaded_parts: [...this.uploaded].sort((a, b) => a - b), updated_at: new Date().toISOString() };
  }
  static fromState(state: UploadState): ResumableUpload {
    return new ResumableUpload(state.blob_id, state.total_parts, state.uploaded_parts);
  }
  persist(storage: { set(key: string, value: string): void }): void {
    storage.set(UPLOAD_STATE_KEY_PREFIX + this.blobId, JSON.stringify(this.toState()));
  }
}

/**
 * What a later process needs to resume an interrupted upload. No plaintext,
 * no file name, no key: the manifest inside is Vault-Key encrypted (the
 * exact string the server stores). Which parts are already stored is asked
 * from the server, not remembered here.
 */
export interface ResumeState {
  v: 1;
  blob_id: string;
  vault_id: string;
  encrypted_manifest_b64: string;
  plaintext_size: number;
  created_at: string;
}

export interface ResumeStore {
  save(state: ResumeState): void;
  remove(blobId: string): void;
  list(): ResumeState[];
}

export const RESUME_KEY_PREFIX = 'my-secrect.upload-resume.v1.';

/** ResumeStore over a Web Storage-like object (localStorage, or a file-backed shim in Node). */
export function webStorageResumeStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>): ResumeStore {
  return {
    save(state) { storage.setItem(RESUME_KEY_PREFIX + state.blob_id, JSON.stringify(state)); },
    remove(blobId) { storage.removeItem(RESUME_KEY_PREFIX + blobId); },
    list() {
      const out: ResumeState[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (!k?.startsWith(RESUME_KEY_PREFIX)) continue;
        try {
          const s = JSON.parse(storage.getItem(k) ?? '') as ResumeState;
          if (s?.v === 1 && typeof s.blob_id === 'string' && typeof s.encrypted_manifest_b64 === 'string') out.push(s);
        } catch { /* unreadable record: never resumed */ }
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Presigned-URL transport — Rails authorises, the client talks to storage
// ---------------------------------------------------------------------------
/** PUT one ciphertext chunk to its presigned URL. Throws on non-2xx. */
export async function uploadPart(url: string, ciphertext: Uint8Array): Promise<void> {
  const res = await fetch(url, { method: 'PUT', body: ciphertext as unknown as BodyInit, headers: { 'Content-Type': 'application/octet-stream' } });
  if (!res.ok) throw new Error(`upload part failed: HTTP ${res.status}`);
}

/** GET one ciphertext chunk from its presigned URL. */
export async function downloadPart(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download part failed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}


// ---------------------------------------------------------------------------
// End-to-end pipeline: encrypt -> upload-session -> PUT parts -> complete,
// and download-session -> GET parts -> verify -> decrypt
// ---------------------------------------------------------------------------

export interface UploadSessionPart {
  part_number: number;
  url: string;
  /** Exact ciphertext size the server signed into `url`. */
  ciphertext_size?: number;
  /** Storage already holds this part at exactly that size (resumed session). */
  stored?: boolean;
}

/** The subset of VaultApiClient the pipeline needs (structurally compatible). */
export interface BlobApi {
  createBlobUploadSession(vaultId: string, body: { blob_id: string; part_count: number; part_size: number; ciphertext_size: number; encrypted_manifest: string }): Promise<{ blob_id: string; resumed?: boolean; parts: UploadSessionPart[] }>;
  completeBlobUpload(blobId: string, parts: Array<{ part_number: number; ciphertext_size: number; ciphertext_sha256_b64: string }>): Promise<unknown>;
  createBlobDownloadSession(blobId: string): Promise<{ blob_id: string; encrypted_manifest: string; parts: Array<{ part_number: number; ciphertext_size: number; url: string }> }>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RetryInfo { op: 'upload' | 'download'; partNumber: number; attempt: number; delayMs: number; error: string }

export interface TransferOptions {
  fetchImpl?: FetchLike;
  /** Attempts per part (>=1). Default 3. Each failed attempt is remembered in the final error. */
  attempts?: number;
  /** Base delay (ms) for exponential backoff between attempts: base, 2x, 4x, … Default 300. */
  backoffMs?: number;
  /** Parallel part transfers (and download read-ahead). Default 4. */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  /** Called after a part is stored (upload). */
  onPartUploaded?: (partNumber: number) => void;
  /** Called before each backoff sleep. */
  onRetry?: (info: RetryInfo) => void;
}

/** Serialise the Vault-Key-encrypted manifest to the opaque base64 string the API stores. */
export function serializeEncryptedManifest(enc: EncryptedManifest): string {
  return toBase64(new TextEncoder().encode(JSON.stringify(enc)));
}
export function parseEncryptedManifest(b64: string): EncryptedManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64(b64)));
  } catch {
    throw new Error('stored manifest is not a valid encrypted manifest envelope');
  }
  if (!isObj(parsed) || typeof parsed.nonce_b64 !== 'string' || typeof parsed.ciphertext_b64 !== 'string' || typeof parsed.encryption_version !== 'number') {
    throw new Error('stored manifest envelope is malformed');
  }
  return parsed as unknown as EncryptedManifest;
}

export class BlobTransferError extends Error {
  constructor(message: string, readonly partNumber?: number) {
    super(message);
    this.name = 'BlobTransferError';
  }
}

/** Thrown when an upload did not finish. `missingParts` are still to send; resume with resumeUpload. */
export class BlobUploadError extends Error {
  constructor(message: string, readonly missingParts: number[], readonly causes: Error[]) {
    super(message);
    this.name = 'BlobUploadError';
  }
}

/** The source no longer yields the ciphertext recorded in the manifest. Nothing was sent for that part. */
export class SourceChangedError extends Error {
  constructor(readonly partNumber: number) {
    super(`the file changed since this upload was prepared (part ${partNumber} no longer matches its manifest); nothing was sent for it — start a new upload`);
    this.name = 'SourceChangedError';
  }
}

function fetchOf(o: TransferOptions): FetchLike {
  const f = o.fetchImpl ?? (globalThis.fetch?.bind(globalThis) as FetchLike | undefined);
  if (!f) throw new Error('no fetch implementation available');
  return f;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** HTTP statuses that retrying cannot fix (expired/forged signature, missing object). */
function isPermanent(status: number): boolean {
  return status === 400 || status === 401 || status === 403 || status === 404;
}

async function withRetry<T>(partNumber: number, op: RetryInfo['op'], o: TransferOptions, fn: () => Promise<T>): Promise<T> {
  const attempts = Math.max(1, o.attempts ?? 3);
  const errors: string[] = [];
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`attempt ${i}: ${msg}`);
      if (e instanceof BlobTransferError && e.message.includes('(permanent)')) break;
      if (i < attempts) {
        const delayMs = (o.backoffMs ?? 300) * 2 ** (i - 1);
        o.onRetry?.({ op, partNumber, attempt: i, delayMs, error: msg });
        await sleep(delayMs);
      }
    }
  }
  throw new BlobTransferError(`${op} part ${partNumber} failed — ${errors.join('; ')}`, partNumber);
}

async function putPart(url: string, ciphertext: Uint8Array, partNumber: number, o: TransferOptions): Promise<void> {
  await withRetry(partNumber, 'upload', o, async () => {
    const res = await fetchOf(o)(url, { method: 'PUT', body: ciphertext as unknown as BodyInit, headers: { 'Content-Type': 'application/octet-stream' } });
    if (!res.ok) {
      const hint = res.status === 403 ? ' — presigned URL expired or rejected; resume the upload to get fresh URLs' : '';
      throw new BlobTransferError(`HTTP ${res.status}${isPermanent(res.status) ? ' (permanent)' : ''}${hint}`, partNumber);
    }
  });
}

async function getPart(url: string, partNumber: number, o: TransferOptions): Promise<Uint8Array> {
  return withRetry(partNumber, 'download', o, async () => {
    const res = await fetchOf(o)(url);
    if (!res.ok) throw new BlobTransferError(`HTTP ${res.status}${isPermanent(res.status) ? ' (permanent)' : ''}`, partNumber);
    return new Uint8Array(await res.arrayBuffer());
  });
}

/** Run fn over items with bounded concurrency. A `fatal` error stops scheduling further items. */
async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>, fatal: (e: Error) => boolean = () => false): Promise<Error[]> {
  const errors: Error[] = [];
  let next = 0;
  let stop = false;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (!stop && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        errors.push(err);
        if (fatal(err)) stop = true;
      }
    }
  });
  await Promise.all(workers);
  return errors;
}

export interface PreparedUpload {
  blobId: string;
  vaultId: string;
  /** Decrypted manifest (local only). */
  manifest: BlobManifest;
  /** The opaque string the server stores. */
  encryptedManifestB64: string;
  source: ChunkSource;
  urls: Map<number, string>;
  tracker: ResumableUpload;
  /** True when the server re-opened an existing session (parts it already holds are marked uploaded). */
  resumed: boolean;
  resumeStore?: ResumeStore;
}

export interface PrepareUploadInput {
  api: BlobApi;
  vaultId: string;
  vaultKey: Uint8Array;
  crypto: CryptoAdapter;
  /** Plaintext: a ChunkSource (read chunk by chunk) or, for small inputs, bytes. */
  source?: ChunkSource;
  data?: Uint8Array;
  fileName: string;
  mimeType: string;
  blobId?: string;
  /** Keeps a ResumeState until the upload completes, so another process can resume it. */
  resumeStore?: ResumeStore;
}

function sourceOf(input: { source?: ChunkSource; data?: Uint8Array }): ChunkSource {
  if (input.source) return input.source;
  if (input.data) return bytesSource(input.data);
  throw new Error('upload needs a source or data');
}

/**
 * Pass 1 + session: encrypt the file chunk by chunk to build the manifest,
 * encrypt the manifest with the Vault Key, then open the server session
 * (presigned part URLs). Nothing is uploaded yet.
 */
export async function prepareUpload(input: PrepareUploadInput): Promise<PreparedUpload> {
  const { api, vaultId, vaultKey, crypto } = input;
  const source = sourceOf(input);
  await sodiumReady;
  const blobId = input.blobId ?? uuidV4(crypto);
  const fileKey = crypto.randomBytes(32);
  let manifest: BlobManifest;
  let state: ResumeState;
  try {
    const plan = await planChunks(source, fileKey, crypto);
    manifest = {
      format_version: MANIFEST_VERSION, blob_id: blobId, plaintext_size: source.size, chunk_size: CHUNK_SIZE,
      mime_type: input.mimeType, file_name: input.fileName, chunks: plan.chunks, plaintext_sha256_b64: toBase64(plan.plaintextSha256),
    };
    await attachWrappedFileKey(manifest, fileKey, vaultKey, crypto);
    verifyManifest(manifest);
    const encryptedManifestB64 = serializeEncryptedManifest(await buildEncryptedManifest(manifest, vaultKey, crypto));
    state = { v: 1, blob_id: blobId, vault_id: vaultId, encrypted_manifest_b64: encryptedManifestB64, plaintext_size: source.size, created_at: new Date().toISOString() };
  } finally {
    fileKey.fill(0);
  }
  // Saved before the session call: if this process dies right after the
  // server opened the session, another one can still resume it.
  input.resumeStore?.save(state);
  try {
    return await openSession(api, state, manifest, source, input.resumeStore);
  } catch (e) {
    input.resumeStore?.remove(blobId);
    throw e;
  }
}

async function openSession(api: BlobApi, state: ResumeState, manifest: BlobManifest, source: ChunkSource, resumeStore?: ResumeStore): Promise<PreparedUpload> {
  const sizes = manifest.chunks.map((c) => c.ciphertext_size);
  const session = await api.createBlobUploadSession(state.vault_id, {
    blob_id: state.blob_id,
    part_count: sizes.length,
    part_size: sizes[0], // every part but the last has this size; the API signs each exact size into its URL
    ciphertext_size: sizes.reduce((a, b) => a + b, 0),
    encrypted_manifest: state.encrypted_manifest_b64,
  });
  if (session.blob_id !== state.blob_id) throw new Error('server opened a session for a different blob');
  if (session.parts.length !== sizes.length) throw new Error(`server returned ${session.parts.length} upload URLs for ${sizes.length} chunks`);
  const urls = new Map<number, string>();
  const stored: number[] = [];
  for (const p of session.parts) {
    if (p.ciphertext_size !== undefined && p.ciphertext_size !== sizes[p.part_number - 1]) {
      throw new Error(`server signed part ${p.part_number} for ${p.ciphertext_size} bytes, the manifest says ${sizes[p.part_number - 1]}`);
    }
    urls.set(p.part_number, p.url);
    if (p.stored) stored.push(p.part_number);
  }
  for (let n = 1; n <= sizes.length; n++) if (!urls.get(n)) throw new Error(`server returned no upload URL for part ${n}`);
  return {
    blobId: state.blob_id, vaultId: state.vault_id, manifest, encryptedManifestB64: state.encrypted_manifest_b64, source, urls,
    tracker: new ResumableUpload(state.blob_id, sizes.length, stored), resumed: !!session.resumed, resumeStore,
  };
}

/**
 * Pass 2: for every part storage does not hold yet, re-read its plaintext,
 * re-encrypt it with its recorded nonce, check the ciphertext hash against
 * the manifest, PUT it (retry + backoff), then call complete. The File Key
 * is unwrapped for this call only and zeroed afterwards.
 */
export async function runUpload(
  api: BlobApi,
  prepared: PreparedUpload,
  keys: { vaultKey: Uint8Array; crypto: CryptoAdapter },
  o: TransferOptions = {},
): Promise<void> {
  const total = prepared.manifest.chunks.length;
  const missing = prepared.tracker.missingParts();
  if (missing.length) {
    await sodiumReady;
    const fileKey = await unwrapFileKey(requireWrappedFileKey(prepared.manifest), keys.vaultKey, keys.crypto);
    let errors: Error[];
    try {
      errors = await pool(missing, o.concurrency ?? 4, async (n) => {
        const info = prepared.manifest.chunks[n - 1];
        const plain = await readRange(prepared.source, info.byte_start, info.byte_end);
        const ciphertext = sealChunk(fileKey, fromBase64(info.nonce_b64), plain);
        if (await sha256B64(ciphertext) !== info.ciphertext_sha256_b64) throw new SourceChangedError(n);
        await putPart(prepared.urls.get(n) as string, ciphertext, n, o);
        prepared.tracker.markUploaded(n);
        o.onPartUploaded?.(n);
        o.onProgress?.(total - prepared.tracker.missingParts().length, total);
      }, (e) => e instanceof SourceChangedError);
    } finally {
      fileKey.fill(0);
    }
    const changed = errors.find((e) => e instanceof SourceChangedError);
    if (changed) {
      prepared.resumeStore?.remove(prepared.blobId);
      throw changed;
    }
    if (!prepared.tracker.isComplete()) {
      throw new BlobUploadError(`upload incomplete: parts ${prepared.tracker.missingParts().join(', ')} not uploaded (${errors.map((e) => e.message).join(' | ')})`, prepared.tracker.missingParts(), errors);
    }
  }
  // The server re-checks every part's existence + exact size in storage; hashes are what the client committed to.
  await api.completeBlobUpload(prepared.blobId, prepared.manifest.chunks.map((c) => ({
    part_number: c.part_number,
    ciphertext_size: c.ciphertext_size,
    ciphertext_sha256_b64: c.ciphertext_sha256_b64,
  })));
  prepared.resumeStore?.remove(prepared.blobId);
}

/**
 * Re-open an interrupted upload from its ResumeState (works from a fresh
 * process). Decrypts the stored manifest with the Vault Key, checks the
 * source has the recorded size, and asks the server which parts storage
 * already holds. Then call runUpload: only missing parts are sent, each
 * checked against the manifest before it leaves.
 */
export async function resumeUpload(input: {
  api: BlobApi;
  vaultKey: Uint8Array;
  crypto: CryptoAdapter;
  source: ChunkSource;
  state: ResumeState;
  resumeStore?: ResumeStore;
}): Promise<PreparedUpload> {
  const { state } = input;
  await sodiumReady;
  const manifest = await decryptManifest(parseEncryptedManifest(state.encrypted_manifest_b64), input.vaultKey, input.crypto);
  if (manifest.blob_id !== state.blob_id) throw new Error('resume record does not match its manifest');
  if (manifest.plaintext_size !== input.source.size) throw new Error(`this is not the file the interrupted upload was for (size ${input.source.size}, expected ${manifest.plaintext_size})`);
  return openSession(input.api, state, manifest, input.source, input.resumeStore);
}

/**
 * The interrupted upload (if any) `source` belongs to: same size, same name
 * and type inside the encrypted manifest, and chunk 1 re-encrypts to
 * exactly the recorded ciphertext. Records that do not decrypt with this
 * Vault Key are skipped.
 */
export async function findResumableUpload(args: {
  store: ResumeStore;
  source: ChunkSource;
  fileName: string;
  mimeType: string;
  vaultKey: Uint8Array;
  crypto: CryptoAdapter;
}): Promise<ResumeState | null> {
  await sodiumReady;
  for (const state of args.store.list()) {
    if (state.plaintext_size !== args.source.size) continue;
    let manifest: BlobManifest;
    try {
      manifest = await decryptManifest(parseEncryptedManifest(state.encrypted_manifest_b64), args.vaultKey, args.crypto);
    } catch {
      continue;
    }
    if (manifest.file_name !== args.fileName || manifest.mime_type !== args.mimeType) continue;
    const first = manifest.chunks[0];
    const fileKey = await unwrapFileKey(requireWrappedFileKey(manifest), args.vaultKey, args.crypto);
    try {
      const ct = sealChunk(fileKey, fromBase64(first.nonce_b64), await readRange(args.source, first.byte_start, first.byte_end));
      if (await sha256B64(ct) === first.ciphertext_sha256_b64) return state;
    } finally {
      fileKey.fill(0);
    }
  }
  return null;
}

export interface UploadFileResult { blobId: string; manifest: BlobManifest }

/** Convenience: prepare + run. On failure the ResumeState (if a store was given) stays for resumeUpload. */
export async function uploadFile(input: PrepareUploadInput, o: TransferOptions = {}): Promise<UploadFileResult> {
  const prepared = await prepareUpload(input);
  await runUpload(input.api, prepared, input, o);
  return { blobId: prepared.blobId, manifest: prepared.manifest };
}

/** Receives verified plaintext, chunk by chunk, in order. */
export interface PlaintextSink {
  write(chunk: Uint8Array): void | Promise<void>;
  /** Called once if the download fails after it started: discard everything written. */
  abort?(reason: Error): void | Promise<void>;
}

export interface DownloadResult {
  manifest: BlobManifest;
  /** Legacy manifests only: the embedded thumbnail, decrypted. */
  thumbnail?: { mimeType: string; bytes: Uint8Array };
}

export interface DownloadedFile extends DownloadResult {
  bytes: Uint8Array;
}

export interface BlobMetadata {
  manifest: BlobManifest;
  thumbnail?: { mimeType: string; bytes: Uint8Array };
}

async function openDownload(api: Pick<BlobApi, 'createBlobDownloadSession'>, blobId: string, vaultKey: Uint8Array, crypto: CryptoAdapter) {
  const session = await api.createBlobDownloadSession(blobId);
  if (session.blob_id !== blobId) throw new Error('download session is for a different blob than requested');
  const manifest = await decryptManifest(parseEncryptedManifest(session.encrypted_manifest), vaultKey, crypto);
  if (manifest.blob_id !== blobId) throw new Error('manifest belongs to a different blob — server returned a substituted manifest');
  return { session, manifest };
}

async function decryptLegacyThumbnail(manifest: BlobManifest, fileKey: Uint8Array, crypto: CryptoAdapter): Promise<DownloadResult['thumbnail']> {
  if (!manifest.thumbnail) return undefined;
  const t = manifest.thumbnail;
  return { mimeType: t.mime_type, bytes: await crypto.decrypt(fileKey, fromBase64(t.nonce_b64), fromBase64(t.ciphertext_b64)) };
}

/**
 * Fetch ONLY the encrypted manifest (no chunk is downloaded), decrypt +
 * verify it, check it belongs to `blobId`, and decrypt a legacy embedded
 * thumbnail. Throws on any authentication or consistency failure.
 */
export async function loadBlobMetadata(
  api: Pick<BlobApi, 'createBlobDownloadSession'>,
  blobId: string,
  vaultKey: Uint8Array,
  crypto: CryptoAdapter,
): Promise<BlobMetadata> {
  const { manifest } = await openDownload(api, blobId, vaultKey, crypto);
  if (!manifest.thumbnail) return { manifest };
  const fileKey = await unwrapFileKey(requireWrappedFileKey(manifest), vaultKey, crypto);
  try {
    return { manifest, thumbnail: await decryptLegacyThumbnail(manifest, fileKey, crypto) };
  } finally {
    fileKey.fill(0);
  }
}

/**
 * download-session -> decrypt + verify manifest -> unwrap File Key -> for
 * each part in order (up to `concurrency` fetched ahead): GET with retry +
 * backoff -> verify length + SHA-256 against the manifest -> AEAD-decrypt
 * -> sink.write. After the last part the whole-plaintext SHA-256 is
 * checked. Any failure aborts the sink and throws. Memory stays at about
 * `concurrency` parts whatever the file size.
 */
export async function downloadToSink(
  api: BlobApi,
  blobId: string,
  vaultKey: Uint8Array,
  crypto: CryptoAdapter,
  sink: PlaintextSink,
  o: TransferOptions = {},
): Promise<DownloadResult> {
  await sodiumReady;
  const { session, manifest } = await openDownload(api, blobId, vaultKey, crypto);
  const wrapped = requireWrappedFileKey(manifest);
  if (session.parts.length !== manifest.chunks.length) throw new Error(`server lists ${session.parts.length} parts, manifest has ${manifest.chunks.length} — truncated or padded`);
  const parts = [...session.parts].sort((a, b) => a.part_number - b.part_number);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].part_number !== i + 1) throw new Error(`server part list is not 1..N (got ${parts[i].part_number} at ${i + 1})`);
    if (parts[i].ciphertext_size !== manifest.chunks[i].ciphertext_size) throw new Error(`server part ${i + 1} size differs from manifest`);
  }
  const fileKey = await unwrapFileKey(wrapped, vaultKey, crypto);
  const window = Math.max(1, o.concurrency ?? 4);
  const inflight = new Map<number, Promise<Uint8Array>>();
  let next = 0;
  try {
    const hash = sha256Stream();
    for (let i = 0; i < parts.length; i++) {
      while (next < parts.length && next < i + window) {
        const p = getPart(parts[next].url, parts[next].part_number, o);
        p.catch(() => undefined); // awaited in order below; no unhandled rejection while an earlier part is pending
        inflight.set(next, p);
        next++;
      }
      const ciphertext = await (inflight.get(i) as Promise<Uint8Array>);
      inflight.delete(i);
      const plain = await openChunk(manifest.chunks[i], ciphertext, fileKey, crypto);
      hash.update(plain);
      await sink.write(plain);
      o.onProgress?.(i + 1, parts.length);
    }
    if (manifest.plaintext_sha256_b64 && toBase64(hash.digest()) !== manifest.plaintext_sha256_b64) {
      throw new Error('decrypted file does not match the SHA-256 recorded in its manifest');
    }
    return { manifest, thumbnail: await decryptLegacyThumbnail(manifest, fileKey, crypto) };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    await sink.abort?.(err);
    throw err;
  } finally {
    fileKey.fill(0);
  }
}

/** downloadToSink into memory. Returns bytes only when every check passed; on failure partial buffers are zeroed. */
export async function downloadFile(
  api: BlobApi,
  blobId: string,
  vaultKey: Uint8Array,
  crypto: CryptoAdapter,
  o: TransferOptions = {},
): Promise<DownloadedFile> {
  const chunks: Uint8Array[] = [];
  const wipe = () => { for (const c of chunks) c.fill(0); chunks.length = 0; };
  const res = await downloadToSink(api, blobId, vaultKey, crypto, { write: (c) => { chunks.push(c); }, abort: wipe }, o);
  const bytes = new Uint8Array(res.manifest.plaintext_size);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  wipe();
  return { ...res, bytes };
}

export { concat };
