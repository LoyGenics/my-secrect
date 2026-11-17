/**
 * Client-side chunked encrypted upload / download.
 *
 * Implemented in code (NOT run against a live server / real blob store).
 *  - Every file gets its own random 32-byte File Key. Each chunk is
 *    encrypted independently with the File Key + a fresh random nonce
 *    (XChaCha20-Poly1305 via the crypto adapter — the adapter's `encrypt`
 *    returns { nonce, ciphertext } with an AEAD tag; a tampered chunk
 *    fails `decrypt` and is never reassembled).
 *  - The manifest binds the whole file: format version, blob id, total
 *    plaintext size, chunk size, ordered chunk list (part number, byte
 *    range, nonce, ciphertext size, SHA-256 of the CIPHERTEXT). A
 *    reordered / truncated / substituted chunk fails verification.
 *  - The manifest itself is encrypted with the Vault Key before it is
 *    stored (see `buildEncryptedManifest`); the server only ever sees
 *    the encrypted manifest + ciphertext chunks.
 *  - Phase C (H8): the manifest ALSO carries the per-file key wrapped
 *    with the Vault Key (`BlobManifest.wrapped_file_key`, via
 *    `wrapFileKey` / `attachWrappedFileKey`). The server stores the
 *    encrypted manifest opaquely on the blob row and returns it at
 *    download time, so a download is decryptable from stored data alone
 *    (manifest + chunks + the Vault Key the client holds): see
 *    `downloadBlob`. A blob whose stored manifest is missing — or whose
 *    manifest has no wrapped key — is refused at Complete / download
 *    time instead of failing silently later. The server stores the
 *    WRAPPED key only, never a plaintext File Key.
 *  - Uploads are resumable: `ResumableUpload` tracks uploaded part
 *    numbers and persists them, so an interrupted upload resumes with
 *    only the missing parts. Parts are uploaded with `PUT` to presigned
 *    URLs obtained from the Rails API (`POST /v1/blobs/upload-session`)
 *    — this file never invents a URL and never uploads to a fake server.
 *  - Downloads support ranges: `chunkIndexForByteRange` maps a byte
 *    range (video seek) to the chunk indices to fetch + decrypt, so a
 *    video can be played without downloading the whole file.
 */
import type { CryptoAdapter } from '../../crypto-adapters/src/index';
import { toBase64, fromBase64 } from '../../crypto-adapters/src/index';

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

export interface BlobManifest {
  format_version: number;
  blob_id: string;
  plaintext_size: number;
  chunk_size: number;
  mime_type: string;
  chunks: ChunkInfo[];
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

async function sha256B64(data: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource);
  return toBase64(new Uint8Array(digest));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
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

/** Encrypt every chunk with the per-file key. Returns chunks + manifest. */
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
 * buildEncryptedManifest. Call this after encryptChunks, before upload:
 * a manifest uploaded without the wrapped key can never be downloaded.
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

/**
 * Full download path, from stored data alone: decrypt the manifest,
 * unwrap the File Key, fetch + verify + decrypt every chunk.
 * `fetchChunk(partNumber)` returns the chunk's nonce + ciphertext bytes
 * (e.g. from the presigned URLs in a download session). Throws on any
 * hash mismatch, AEAD failure, or missing wrapped key — a tampered or
 * incomplete download is never returned.
 */
export async function downloadBlob(
  encryptedManifest: EncryptedManifest,
  vaultKey: Uint8Array,
  crypto: CryptoAdapter,
  fetchChunk: (partNumber: number) => Promise<EncryptedChunk>,
): Promise<Uint8Array> {
  const manifest = await decryptManifest(encryptedManifest, vaultKey, crypto);
  const wrapped = requireWrappedFileKey(manifest);
  const fileKey = await unwrapFileKey(wrapped, vaultKey, crypto);
  const chunks: EncryptedChunk[] = [];
  for (const info of manifest.chunks) {
    chunks.push(await fetchChunk(info.part_number));
  }
  return decryptChunks(chunks, manifest, fileKey, crypto);
}

/** Encrypt the manifest itself with the Vault Key (server never sees it). */
export async function buildEncryptedManifest(manifest: BlobManifest, vaultKey: Uint8Array, crypto: CryptoAdapter): Promise<EncryptedManifest> {
  const { nonce, ciphertext } = await crypto.encrypt(vaultKey, new TextEncoder().encode(JSON.stringify(manifest)));
  return { nonce_b64: toBase64(nonce), ciphertext_b64: toBase64(ciphertext), encryption_version: 1 };
}

export async function decryptManifest(enc: EncryptedManifest, vaultKey: Uint8Array, crypto: CryptoAdapter): Promise<BlobManifest> {
  const plain = await crypto.decrypt(vaultKey, fromBase64(enc.nonce_b64), fromBase64(enc.ciphertext_b64));
  const manifest = JSON.parse(new TextDecoder().decode(plain)) as BlobManifest;
  verifyManifest(manifest);
  return manifest;
}

/**
 * Verify a manifest's internal consistency. Throws on any mismatch:
 * wrong version, non-contiguous / out-of-order chunks, size mismatch.
 * (Per-chunk ciphertext hashes are checked again at download time.)
 */
export function verifyManifest(manifest: BlobManifest): void {
  if (manifest.format_version !== MANIFEST_VERSION) throw new Error(`unsupported manifest version ${manifest.format_version}`);
  if (!manifest.chunks.length) throw new Error('manifest has no chunks');
  let expectedStart = 0;
  for (let i = 0; i < manifest.chunks.length; i++) {
    const c = manifest.chunks[i];
    if (c.part_number !== i + 1) throw new Error(`chunk out of order at index ${i}`);
    if (c.byte_start !== expectedStart) throw new Error(`chunk ${c.part_number} is not contiguous`);
    if (c.byte_end <= c.byte_start && manifest.plaintext_size > 0) throw new Error(`chunk ${c.part_number} has an empty range`);
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

/** Decrypt + verify downloaded chunks, in order, into the original bytes. */
export async function decryptChunks(
  chunks: EncryptedChunk[],
  manifest: BlobManifest,
  fileKey: Uint8Array,
  crypto: CryptoAdapter,
): Promise<Uint8Array> {
  verifyManifest(manifest);
  if (chunks.length !== manifest.chunks.length) throw new Error(`expected ${manifest.chunks.length} chunks, got ${chunks.length}`);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const info = manifest.chunks[i];
    if (chunk.part_number !== info.part_number) throw new Error(`chunk ${i + 1} out of order`);
    if (chunk.ciphertext.length !== info.ciphertext_size) throw new Error(`chunk ${info.part_number} size mismatch — possible truncation`);
    const hash = await sha256B64(chunk.ciphertext);
    if (hash !== info.ciphertext_sha256_b64) throw new Error(`chunk ${info.part_number} hash mismatch — tampered or substituted`);
    // AEAD decrypt throws on a bad tag: a tampered chunk is never returned.
    parts.push(await crypto.decrypt(fileKey, chunk.nonce, chunk.ciphertext));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  if (out.length !== manifest.plaintext_size) throw new Error('reassembled size does not match manifest');
  return out;
}

// ---------------------------------------------------------------------------
// Resumable upload state — persisted so an interrupted upload resumes
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

export { concat };
