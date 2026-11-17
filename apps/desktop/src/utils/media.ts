/**
 * Media helpers for the desktop/web vault — metadata + encrypted upload/download.
 *
 * Verified by packages/storage/tests/upload.real.test.mts (real crypto) and
 * tests/media-e2e (real API + MinIO). The browser UI path was exercised with
 * Playwright/Chromium (see docs/implementation-status.md).
 *  - A media item's `fields` carry ONLY metadata (file name, mime type,
 *    size, blob id, plaintext SHA-256). They live inside the item, which is
 *    already encrypted with its Item Key. The file bytes live as encrypted
 *    chunks in object storage; the manifest (chunk list, sizes, hashes,
 *    wrapped File Key, optional encrypted thumbnail) is itself encrypted
 *    with the Vault Key — see packages/storage/src/upload.ts.
 *  - Thumbnails are generated ON THE CLIENT and encrypted (inside the
 *    manifest, with the File Key) before upload. The server never generates
 *    or sees a thumbnail. If a thumbnail cannot be generated the upload
 *    still proceeds WITHOUT one and the caller is told why — never a
 *    plaintext fallback.
 *  - Whole files are held in memory while being encrypted/decrypted
 *    (no streaming yet), so uploads above MAX_MEDIA_BYTES are refused with
 *    a clear error rather than crashing the tab.
 *  - Preview plaintext exists only in RAM (and, while displayed, in the
 *    OS graphics pipeline). Object URLs must be revoked on lock / unmount.
 *    It cannot be guaranteed unrecoverable on a fully compromised device.
 */
import type { VaultItem } from '../../../../packages/core/src/types';
import type { BlobManifest } from '../../../../packages/storage/src/upload';
import {
  chunkIndexForByteRange,
  verifyManifest,
  CHUNK_SIZE,
  uploadFile,
  downloadFile,
  loadBlobMetadata,
  type BlobApi,
  type TransferOptions,
} from '../../../../packages/storage/src/upload';
import { libsodiumAdapter, sodiumReady } from '../../../../packages/crypto-adapters/src/index';

export { chunkIndexForByteRange, verifyManifest, CHUNK_SIZE };
export type { BlobManifest };

export type MediaKind = 'photo' | 'video' | 'audio' | 'document' | 'other';

export function mediaKindFromMime(mimeType: string): MediaKind {
  if (mimeType.startsWith('image/')) return 'photo';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'document';
  return 'other';
}

export const SUPPORTED_MEDIA_MIMES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/wav', 'audio/ogg',
  'application/pdf',
] as const;

export function isSupportedMime(mimeType: string): boolean {
  return (SUPPORTED_MEDIA_MIMES as readonly string[]).includes(mimeType);
}

export interface MediaInfo {
  blob_id: string;
  mime_type: string;
  kind: MediaKind;
  size_bytes: number;
  width?: number;
  height?: number;
  duration_s?: number;
  thumbnail_blob_id?: string;
}

export function mediaInfoFromItem(item: VaultItem): MediaInfo | null {
  if (item.type !== 'media' && item.type !== 'document') return null;
  const f = item.fields as Record<string, unknown>;
  const legacySize = typeof f.size === 'string' ? Number(f.size) : NaN;
  const blobId = typeof f.blob_id === 'string' ? f.blob_id : item.attachments[0];
  if (!blobId) return null;
  const mimeType = typeof f.mime_type === 'string' ? f.mime_type : 'application/octet-stream';
  return {
    blob_id: blobId,
    mime_type: mimeType,
    kind: mediaKindFromMime(mimeType),
    size_bytes: typeof f.size_bytes === 'number' ? f.size_bytes : Number.isFinite(legacySize) ? legacySize : 0,
    width: typeof f.width === 'number' ? f.width : undefined,
    height: typeof f.height === 'number' ? f.height : undefined,
    duration_s: typeof f.duration_s === 'number' ? f.duration_s : undefined,
    thumbnail_blob_id: typeof f.thumbnail_blob_id === 'string' ? f.thumbnail_blob_id : undefined,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export type ManifestStatus = 'verified' | 'missing' | 'tampered' | 'unknown';

/**
 * Check a manifest the caller already decrypted. `unknown` means no
 * manifest is available yet (not uploaded / not synced) — not an error.
 */
export function manifestStatus(manifest: BlobManifest | null | undefined): ManifestStatus {
  if (!manifest) return 'unknown';
  try {
    verifyManifest(manifest);
    return 'verified';
  } catch {
    return 'tampered';
  }
}

/** Human label for a video seek: which chunks a byte position needs. */
export function seekChunksLabel(manifest: BlobManifest, byteOffset: number): string {
  const parts = chunkIndexForByteRange(manifest, byteOffset, Math.min(byteOffset + 1, manifest.plaintext_size));
  return parts.length ? `seek → chunk${parts.length > 1 ? 's' : ''} ${parts.join(', ')} of ${manifest.chunks.length}` : 'seek → no chunk';
}

// ---------------------------------------------------------------------------
// Upload / download service (UI-independent; used by MediaView)
// ---------------------------------------------------------------------------

/** In-memory encrypt/decrypt ceiling (no streaming yet). */
export const MAX_MEDIA_BYTES = 256 * 1024 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Items made with the old "manifest only" form carry a `blob_xxxx` id that was never uploaded. */
export function isUploadedBlobId(blobId: string): boolean {
  return UUID_RE.test(blobId);
}

export type MediaApi = BlobApi & {
  listVaults(): Promise<{ vaults: Array<{ id: string }> }>;
  createVault(encryptedMetadataB64: string): Promise<{ vault: { id: string } }>;
};

/** Callback giving access to the in-memory Vault Key (vault.ts `withVaultKey`). */
export type WithVaultKey = <T>(fn: (key: Uint8Array) => Promise<T>) => Promise<T>;

/**
 * The server vault that holds this account's blobs. Uses the first vault the
 * account has; creates one (opaque encrypted metadata) only when there is none.
 */
export async function resolveServerVaultId(api: MediaApi, makeEncryptedMetadataB64: () => Promise<string>): Promise<string> {
  const { vaults } = await api.listVaults();
  if (vaults.length > 0) return vaults[0].id;
  const created = await api.createVault(await makeEncryptedMetadataB64());
  return created.vault.id;
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Client-side thumbnail for images (max 256px, JPEG). Returns null when the
 * file is not an image or the platform lacks createImageBitmap/canvas;
 * throws nothing for "no thumbnail", but a decode failure of a file that
 * claims to be an image is reported through `warning`.
 */
export async function generateThumbnail(file: Blob): Promise<{ thumbnail: { mimeType: string; bytes: Uint8Array } | null; warning?: string; width?: number; height?: number }> {
  if (!file.type.startsWith('image/')) return { thumbnail: null };
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    return { thumbnail: null, warning: 'Thumbnail not generated: this environment cannot decode images.' };
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { thumbnail: null, warning: 'Thumbnail not generated: the image could not be decoded.' };
  }
  try {
    const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return { thumbnail: null, warning: 'Thumbnail not generated: no 2D canvas available.', width: bitmap.width, height: bitmap.height };
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.8));
    if (!blob) return { thumbnail: null, warning: 'Thumbnail not generated: canvas export failed.', width: bitmap.width, height: bitmap.height };
    return { thumbnail: { mimeType: 'image/jpeg', bytes: new Uint8Array(await blob.arrayBuffer()) }, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

export interface UploadMediaResult {
  item: VaultItem;
  manifest: BlobManifest;
  warning?: string;
}

/**
 * Encrypt a user-chosen file client-side, upload ciphertext chunks via
 * presigned URLs, and return the (not yet stored) vault item that points at
 * the blob. Throws loudly on any failure; nothing is half-recorded.
 */
export async function uploadMediaFile(args: {
  api: MediaApi;
  file: File;
  withVaultKey: WithVaultKey;
  makeEncryptedMetadataB64: () => Promise<string>;
  transfer?: TransferOptions;
}): Promise<UploadMediaResult> {
  const { api, file, withVaultKey } = args;
  if (file.size > MAX_MEDIA_BYTES) throw new Error(`File is ${formatBytes(file.size)}; the limit for in-memory encryption is ${formatBytes(MAX_MEDIA_BYTES)}.`);
  await sodiumReady;
  const data = new Uint8Array(await file.arrayBuffer());
  const mimeType = file.type || 'application/octet-stream';
  const sha256 = hex(await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource));
  const thumb = await generateThumbnail(file);
  const vaultId = await resolveServerVaultId(api, args.makeEncryptedMetadataB64);
  const { blobId, manifest } = await withVaultKey((vaultKey) =>
    uploadFile({ api, vaultId, vaultKey, crypto: libsodiumAdapter, data, fileName: file.name, mimeType, thumbnail: thumb.thumbnail ?? undefined }, args.transfer),
  );
  const now = new Date().toISOString();
  const kind = mediaKindFromMime(mimeType);
  const item: VaultItem = {
    id: 'item_' + globalThis.crypto.randomUUID(),
    type: kind === 'photo' || kind === 'video' || kind === 'audio' ? 'media' : 'document',
    schema_version: 1,
    title: file.name,
    fields: {
      file_name: file.name,
      blob_id: blobId,
      mime_type: mimeType,
      size_bytes: file.size,
      size: String(file.size),
      sha256,
      ...(thumb.width ? { width: thumb.width, height: thumb.height } : {}),
    },
    tags: [],
    relations: [],
    attachments: [blobId],
    created_at: now,
    updated_at: now,
  };
  return { item, manifest, warning: thumb.warning };
}

export interface DownloadedMedia { bytes: Uint8Array; fileName: string; mimeType: string; sha256Matches: boolean | null }

/** Download + verify + decrypt a blob. Throws on any failure; never returns unverified bytes. */
export async function downloadMediaItem(args: { api: MediaApi; item: VaultItem; withVaultKey: WithVaultKey; transfer?: TransferOptions }): Promise<DownloadedMedia> {
  const info = mediaInfoFromItem(args.item);
  if (!info) throw new Error('This item is not a media item.');
  if (!isUploadedBlobId(info.blob_id)) throw new Error('This item has no uploaded file: it was created with the old manifest-only form (no bytes were ever stored).');
  await sodiumReady;
  const got = await args.withVaultKey((vaultKey) => downloadFile(args.api, info.blob_id, vaultKey, libsodiumAdapter, args.transfer));
  const f = args.item.fields as Record<string, unknown>;
  let sha256Matches: boolean | null = null;
  if (typeof f.sha256 === 'string' && f.sha256) {
    sha256Matches = hex(await globalThis.crypto.subtle.digest('SHA-256', got.bytes as BufferSource)) === f.sha256;
    if (!sha256Matches) throw new Error('Decrypted file does not match the SHA-256 recorded in the item — refusing to release it.');
  }
  return { bytes: got.bytes, fileName: got.manifest.file_name ?? args.item.title, mimeType: got.manifest.mime_type, sha256Matches };
}

export interface MediaMetadata { manifest: BlobManifest; thumbnailUrl?: string }

/** Load + verify one blob's encrypted manifest (and thumbnail as an object URL). Caller must revoke `thumbnailUrl`. */
export async function loadMediaMetadata(args: { api: MediaApi; blobId: string; withVaultKey: WithVaultKey }): Promise<MediaMetadata> {
  await sodiumReady;
  const meta = await args.withVaultKey((vaultKey) => loadBlobMetadata(args.api, args.blobId, vaultKey, libsodiumAdapter));
  const thumbnailUrl = meta.thumbnail ? URL.createObjectURL(new Blob([meta.thumbnail.bytes as BlobPart], { type: meta.thumbnail.mimeType })) : undefined;
  return { manifest: meta.manifest, thumbnailUrl };
}
