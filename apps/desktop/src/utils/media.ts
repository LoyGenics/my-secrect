/**
 * Media helpers for the desktop/web vault — metadata + encrypted upload/download.
 *
 * Verified by packages/storage/tests/upload.real.test.mts (real crypto) and
 * tests/media-e2e (real API + MinIO; two devices; kill + resume; Chromium).
 *  - A media item's `fields` carry ONLY metadata (file name, mime type,
 *    size, blob ids, plaintext SHA-256, dimensions/duration). They live
 *    inside the item, which is encrypted with its Item Key. The file bytes
 *    live as encrypted chunks in object storage; the manifest (chunk list,
 *    sizes, hashes, wrapped File Key) is itself encrypted with the Vault
 *    Key — see packages/storage/src/upload.ts.
 *  - Thumbnails are generated ON THIS DEVICE (images: downscaled; videos:
 *    one frame), then encrypted and uploaded as their OWN blob
 *    (`thumbnail_blob_id`) with their own File Key. The server never
 *    generates or sees a thumbnail. If one cannot be generated or uploaded
 *    the file is still stored WITHOUT one and the caller is told why —
 *    never a plaintext fallback. Items from before keep an embedded
 *    thumbnail inside their manifest; loadMediaMetadata still reads it.
 *  - Uploads stream: the file is read and encrypted one 1 MiB chunk at a
 *    time (blobSource), never whole. An interrupted upload leaves a resume
 *    record (no plaintext, no key) in the given ResumeStore; choosing the
 *    same file again resumes it and sends only the parts storage lacks.
 *  - Downloads verify every chunk before it is decrypted and assemble the
 *    plaintext IN MEMORY only (a Blob handed to the browser on success);
 *    nothing is written to disk by the app. That is why one file is capped
 *    at MAX_MEDIA_BYTES. Object URLs must be revoked after use.
 *  - Preview plaintext exists only in RAM (and, while displayed, in the
 *    OS graphics pipeline). It cannot be guaranteed unrecoverable on a
 *    fully compromised device.
 */
import type { VaultItem } from '../../../../packages/core/src/types';
import type { BlobManifest, ResumeStore } from '../../../../packages/storage/src/upload';
import {
  chunkIndexForByteRange,
  verifyManifest,
  CHUNK_SIZE,
  blobSource,
  bytesSource,
  bytesToHex,
  prepareUpload,
  resumeUpload,
  findResumableUpload,
  decryptManifest,
  parseEncryptedManifest,
  runUpload,
  uploadFile,
  downloadFile,
  downloadToSink,
  loadBlobMetadata,
  type BlobApi,
  type PreparedUpload,
  type TransferOptions,
} from '../../../../packages/storage/src/upload';
import { libsodiumAdapter, sodiumReady, fromBase64 } from '../../../../packages/crypto-adapters/src/index';

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

/** Per-file ceiling: decrypted downloads and previews are assembled in memory (never on disk). */
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

export interface GeneratedThumbnail {
  thumbnail: { mimeType: string; bytes: Uint8Array } | null;
  warning?: string;
  width?: number;
  height?: number;
  durationS?: number;
}

const THUMB_MAX = 256;

async function canvasJpeg(source: CanvasImageSource, w: number, h: number): Promise<Uint8Array | null> {
  const scale = Math.min(1, THUMB_MAX / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.8));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/** Load a local file into a <video>/<audio> element (object URL, revoked before returning) and run `fn` on it. */
async function withMediaElement<T>(file: Blob, tag: 'video' | 'audio', fn: (el: HTMLMediaElement) => Promise<T>): Promise<T> {
  const url = URL.createObjectURL(file);
  const el = document.createElement(tag);
  el.preload = 'metadata';
  el.muted = true;
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out reading media metadata')), 10_000);
      el.onloadedmetadata = () => { clearTimeout(t); resolve(); };
      el.onerror = () => { clearTimeout(t); reject(new Error('the browser cannot decode this file')); };
      el.src = url;
    });
    return await fn(el);
  } finally {
    el.removeAttribute('src');
    el.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * Client-side thumbnail (max 256px, JPEG) for images and videos (one frame
 * near the start), plus dimensions / duration. Returns no thumbnail when the
 * platform cannot decode the file; a decode failure of a file that claims to
 * be an image/video is reported through `warning`.
 */
export async function generateThumbnail(file: Blob): Promise<GeneratedThumbnail> {
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  const isAudio = file.type.startsWith('audio/');
  if (!isImage && !isVideo && !isAudio) return { thumbnail: null };
  if (typeof document === 'undefined') return { thumbnail: null, warning: 'Thumbnail not generated: this environment cannot decode media.' };
  if (isImage) {
    if (typeof createImageBitmap !== 'function') return { thumbnail: null, warning: 'Thumbnail not generated: this environment cannot decode images.' };
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return { thumbnail: null, warning: 'Thumbnail not generated: the image could not be decoded.' };
    }
    try {
      const bytes = await canvasJpeg(bitmap, bitmap.width, bitmap.height);
      if (!bytes) return { thumbnail: null, warning: 'Thumbnail not generated: canvas export failed.', width: bitmap.width, height: bitmap.height };
      return { thumbnail: { mimeType: 'image/jpeg', bytes }, width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  }
  try {
    return await withMediaElement(file, isVideo ? 'video' : 'audio', async (el) => {
      const durationS = Number.isFinite(el.duration) ? el.duration : undefined;
      if (!isVideo) return { thumbnail: null, durationS };
      const v = el as HTMLVideoElement;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out seeking the video')), 10_000);
        v.onseeked = () => { clearTimeout(t); resolve(); };
        v.currentTime = Math.min(1, (durationS ?? 0) / 10);
      });
      const bytes = await canvasJpeg(v, v.videoWidth, v.videoHeight);
      return { thumbnail: bytes ? { mimeType: 'image/jpeg', bytes } : null, width: v.videoWidth, height: v.videoHeight, durationS, ...(bytes ? {} : { warning: 'Thumbnail not generated: canvas export failed.' }) };
    });
  } catch (e) {
    return { thumbnail: null, warning: `Thumbnail not generated: ${e instanceof Error ? e.message : String(e)}.` };
  }
}

export interface UploadMediaResult {
  item: VaultItem;
  manifest: BlobManifest;
  /** Parts storage already held from an interrupted upload of this file (0 = fresh upload). */
  resumedParts: number;
  warning?: string;
}

export interface UploadMediaArgs {
  api: MediaApi;
  file: File;
  withVaultKey: WithVaultKey;
  makeEncryptedMetadataB64: () => Promise<string>;
  /** Where interrupted uploads are remembered (browser: localStorage). Without it nothing can be resumed. */
  resumeStore?: ResumeStore;
  transfer?: TransferOptions;
  /** Thumbnail generator; defaults to generateThumbnail (needs a DOM). */
  makeThumbnail?: (file: File) => Promise<GeneratedThumbnail>;
}

/** Resume this file's interrupted upload if the store has one that still exists on the server; else start fresh. */
async function startOrResume(args: UploadMediaArgs, mimeType: string): Promise<{ prepared: PreparedUpload } | { done: BlobManifest }> {
  const { api, file, resumeStore } = args;
  const source = blobSource(file);
  const state = resumeStore
    ? await args.withVaultKey((vaultKey) => findResumableUpload({ store: resumeStore, source, fileName: file.name, mimeType, vaultKey, crypto: libsodiumAdapter }))
    : null;
  if (state && resumeStore) {
    try {
      return { prepared: await args.withVaultKey((vaultKey) => resumeUpload({ api, vaultKey, crypto: libsodiumAdapter, source, state, resumeStore })) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/expired|blob is (complete|failed)|different manifest/.test(msg)) throw e;
      resumeStore.remove(state.blob_id);
      if (/blob is complete/.test(msg)) {
        // The earlier run finished the upload but stopped before the item was saved.
        return { done: await args.withVaultKey((vaultKey) => decryptManifest(parseEncryptedManifest(state.encrypted_manifest_b64), vaultKey, libsodiumAdapter)) };
      }
      // Session expired or gone on the server: start a new upload below.
    }
  }
  const vaultId = await resolveServerVaultId(api, args.makeEncryptedMetadataB64);
  return {
    prepared: await args.withVaultKey((vaultKey) =>
      prepareUpload({ api, vaultId, vaultKey, crypto: libsodiumAdapter, source, fileName: file.name, mimeType, resumeStore })),
  };
}

/**
 * Encrypt a user-chosen file on this device chunk by chunk, upload the
 * ciphertext via presigned URLs (resuming an interrupted upload of the same
 * file when the store has one), then generate + encrypt + upload its
 * thumbnail as a separate blob, and return the (not yet stored) vault item
 * that points at both. Throws loudly on any failure of the file itself;
 * nothing is half-recorded.
 */
export async function uploadMediaFile(args: UploadMediaArgs): Promise<UploadMediaResult> {
  const { api, file } = args;
  if (file.size > MAX_MEDIA_BYTES) throw new Error(`File is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_MEDIA_BYTES)} per file.`);
  await sodiumReady;
  const mimeType = file.type || 'application/octet-stream';
  const started = await startOrResume(args, mimeType);
  let manifest: BlobManifest;
  let resumedParts = 0;
  if ('done' in started) {
    manifest = started.done;
    resumedParts = manifest.chunks.length;
  } else {
    const { prepared } = started;
    resumedParts = prepared.tracker.toState().uploaded_parts.length;
    await args.withVaultKey((vaultKey) => runUpload(api, prepared, { vaultKey, crypto: libsodiumAdapter }, args.transfer));
    manifest = prepared.manifest;
  }
  const blobId = manifest.blob_id;

  const thumb = await (args.makeThumbnail ?? generateThumbnail)(file);
  let warning = thumb.warning;
  let thumbnailBlobId: string | undefined;
  if (thumb.thumbnail) {
    try {
      const vaultId = await resolveServerVaultId(api, args.makeEncryptedMetadataB64);
      const t = thumb.thumbnail;
      const r = await args.withVaultKey((vaultKey) => uploadFile({ api, vaultId, vaultKey, crypto: libsodiumAdapter, source: bytesSource(t.bytes), fileName: 'thumbnail.jpg', mimeType: t.mimeType }, args.transfer));
      thumbnailBlobId = r.blobId;
    } catch (e) {
      warning = `Thumbnail not stored: ${e instanceof Error ? e.message : String(e)}.`;
    }
  }

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
      ...(manifest.plaintext_sha256_b64 ? { sha256: bytesToHex(fromBase64(manifest.plaintext_sha256_b64)) } : {}),
      ...(thumb.width ? { width: thumb.width, height: thumb.height } : {}),
      ...(thumb.durationS !== undefined ? { duration_s: thumb.durationS } : {}),
      ...(thumbnailBlobId ? { thumbnail_blob_id: thumbnailBlobId } : {}),
    },
    tags: [],
    relations: [],
    attachments: thumbnailBlobId ? [blobId, thumbnailBlobId] : [blobId],
    created_at: now,
    updated_at: now,
  };
  return { item, manifest, resumedParts, warning };
}

export interface DownloadedMedia { blob: Blob; fileName: string; mimeType: string; sha256Matches: boolean | null }

/**
 * Download + verify + decrypt a blob into an in-memory Blob. Every chunk is
 * verified before it is decrypted; the Blob is built only after the last
 * chunk and the whole-file hashes (manifest + item) passed. On failure the
 * partial plaintext is zeroed and nothing is returned.
 */
export async function downloadMediaItem(args: { api: MediaApi; item: VaultItem; withVaultKey: WithVaultKey; transfer?: TransferOptions }): Promise<DownloadedMedia> {
  const info = mediaInfoFromItem(args.item);
  if (!info) throw new Error('This item is not a media item.');
  if (!isUploadedBlobId(info.blob_id)) throw new Error('This item has no uploaded file: it was created with the old manifest-only form (no bytes were ever stored).');
  if (info.size_bytes > MAX_MEDIA_BYTES) throw new Error(`File is ${formatBytes(info.size_bytes)}; decrypting more than ${formatBytes(MAX_MEDIA_BYTES)} in memory is refused.`);
  await sodiumReady;
  const parts: Uint8Array[] = [];
  const wipe = () => { for (const p of parts) p.fill(0); parts.length = 0; };
  const res = await args.withVaultKey((vaultKey) => downloadToSink(args.api, info.blob_id, vaultKey, libsodiumAdapter, { write: (c) => { parts.push(c); }, abort: wipe }, args.transfer));
  const f = args.item.fields as Record<string, unknown>;
  let sha256Matches: boolean | null = null;
  if (typeof f.sha256 === 'string' && f.sha256) {
    const fromManifest = res.manifest.plaintext_sha256_b64 ? bytesToHex(fromBase64(res.manifest.plaintext_sha256_b64)) : null;
    // New manifests carry the whole-file SHA-256 (verified by downloadToSink); older ones are hashed here.
    const actual = fromManifest ?? bytesToHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', await new Blob(parts as BlobPart[]).arrayBuffer())));
    sha256Matches = actual === f.sha256;
    if (!sha256Matches) {
      wipe();
      throw new Error('Decrypted file does not match the SHA-256 recorded in the item — refusing to release it.');
    }
  }
  const blob = new Blob(parts as BlobPart[], { type: res.manifest.mime_type });
  wipe();
  return { blob, fileName: res.manifest.file_name ?? args.item.title, mimeType: res.manifest.mime_type, sha256Matches };
}

export interface MediaMetadata { manifest: BlobManifest; thumbnailUrl?: string }

/** Load + verify one blob's encrypted manifest (and a legacy embedded thumbnail as an object URL). Caller must revoke `thumbnailUrl`. */
export async function loadMediaMetadata(args: { api: MediaApi; blobId: string; withVaultKey: WithVaultKey }): Promise<MediaMetadata> {
  await sodiumReady;
  const meta = await args.withVaultKey((vaultKey) => loadBlobMetadata(args.api, args.blobId, vaultKey, libsodiumAdapter));
  const thumbnailUrl = meta.thumbnail ? URL.createObjectURL(new Blob([meta.thumbnail.bytes as BlobPart], { type: meta.thumbnail.mimeType })) : undefined;
  return { manifest: meta.manifest, thumbnailUrl };
}

/**
 * Download + decrypt a thumbnail blob (`thumbnail_blob_id`) into an object
 * URL. Refuses anything that does not decrypt to a small image. Caller must
 * revoke the URL.
 */
export async function loadThumbnailUrl(args: { api: MediaApi; thumbnailBlobId: string; withVaultKey: WithVaultKey }): Promise<string> {
  await sodiumReady;
  const got = await args.withVaultKey((vaultKey) => downloadFile(args.api, args.thumbnailBlobId, vaultKey, libsodiumAdapter));
  if (!got.manifest.mime_type.startsWith('image/') || got.bytes.length > 2 * 1024 * 1024) {
    got.bytes.fill(0);
    throw new Error('thumbnail blob is not a small image');
  }
  const url = URL.createObjectURL(new Blob([got.bytes as BlobPart], { type: got.manifest.mime_type }));
  got.bytes.fill(0);
  return url;
}
