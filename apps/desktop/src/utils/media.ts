/**
 * Media helpers for the desktop vault — metadata + encrypted manifests.
 *
 * Implemented in code (NOT run against a real blob store).
 *  - A media item's `fields` carry ONLY metadata (mime type, size,
 *    dimensions, duration, blob id). The file bytes live as encrypted
 *    chunks in object storage; the manifest (chunk list, sizes, hashes,
 *    wrapped File Key) is itself encrypted with the Vault Key — see
 *    packages/storage/src/upload.ts (`BlobManifest`, `EncryptedManifest`).
 *  - Thumbnails are generated ON THE CLIENT and encrypted before upload.
 *    The server never generates thumbnails. A thumbnail is never stored
 *    or shown in plaintext outside the decrypted session.
 *  - Preview plaintext exists only in RAM (and, while displayed, in the
 *    OS graphics pipeline). It must be released on lock / unmount
 *    (`URL.revokeObjectURL`) — it cannot be guaranteed unrecoverable on
 *    a fully compromised device. The UI must say so, not hide it.
 *  - Video uses range/chunk mapping: `chunkIndexForByteRange` (re-exported
 *    here) maps a seek position to the chunks to fetch + decrypt, so
 *    playback does not need the whole file first.
 */
import type { VaultItem } from '../../../../packages/core/src/types';
import type { BlobManifest } from '../../../../packages/storage/src/upload';
import { chunkIndexForByteRange, verifyManifest, CHUNK_SIZE } from '../../../../packages/storage/src/upload';

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
  const blobId = typeof f.blob_id === 'string' ? f.blob_id : item.attachments[0];
  if (!blobId) return null;
  const mimeType = typeof f.mime_type === 'string' ? f.mime_type : 'application/octet-stream';
  return {
    blob_id: blobId,
    mime_type: mimeType,
    kind: mediaKindFromMime(mimeType),
    size_bytes: typeof f.size_bytes === 'number' ? f.size_bytes : 0,
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
