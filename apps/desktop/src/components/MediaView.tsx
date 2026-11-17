import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VaultItem } from '../../../../packages/core/src/types';
import type { BlobManifest } from '../../../../packages/storage/src/upload';
import {
  mediaInfoFromItem,
  formatBytes,
  formatDuration,
  manifestStatus,
  seekChunksLabel,
  isSupportedMime,
  isUploadedBlobId,
  uploadMediaFile,
  downloadMediaItem,
  loadMediaMetadata,
  MAX_MEDIA_BYTES,
  type MediaApi,
} from '../utils/media';
import { upsertItem, withVaultKey, encryptWithVaultKey } from '../vault';

/**
 * MediaView — encrypted file upload / download / gallery.
 *
 *  - Upload: the chosen file is encrypted ON THIS DEVICE in 1 MiB chunks
 *    (per-file random File Key, XChaCha20-Poly1305 v1), the manifest
 *    (name, type, size, chunk hashes, wrapped File Key, optional encrypted
 *    thumbnail) is encrypted with the Vault Key, and only ciphertext goes
 *    to object storage through presigned URLs. See utils/media.ts.
 *  - Download: chunks are fetched, verified against the authenticated
 *    manifest (count, order, length, hash) and decrypted; any failure is
 *    shown as an error and nothing is saved.
 *  - Per item the manifest is fetched and verified when the view opens.
 *    Status is shown honestly: verified / failed (with reason) / not
 *    uploaded (old manifest-only item) / unknown (no account server).
 *  - Thumbnails come only from the encrypted manifest (decrypted here and
 *    shown as an object URL); otherwise the tile shows an icon.
 *  - Preview plaintext exists only in RAM while displayed; object URLs are
 *    revoked on unmount. A fully compromised device is not protected.
 *  - Works unchanged in the web client (same component). Needs a configured
 *    account server: with no API base URL nothing can be stored remotely and
 *    the UI says so.
 */

export interface MediaViewProps {
  items: VaultItem[];
  /** Account-server client (null = local-only: upload/download disabled with an explanation). */
  api?: MediaApi | null;
  /** Called after an uploaded item was added to the local vault so the shell can refresh its list. */
  onItemsChanged?: () => void;
  onSelect?: (item: VaultItem) => void;
}

const KIND_ICON: Record<string, string> = {
  photo: '🖼️',
  video: '🎬',
  audio: '🎵',
  document: '📄',
  other: '📦',
};

export default function MediaView({ items, api = null, onItemsChanged, onSelect }: MediaViewProps) {
  const [filter, setFilter] = useState<'all' | 'photo' | 'video' | 'audio' | 'document' | 'other'>('all');
  const [manifests, setManifests] = useState<Record<string, BlobManifest>>({});
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [metaErrors, setMetaErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const thumbRef = useRef<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);

  const mediaItems = useMemo(() => {
    const list = items
      .map((item) => ({ item, info: mediaInfoFromItem(item) }))
      .filter((x): x is { item: VaultItem; info: NonNullable<ReturnType<typeof mediaInfoFromItem>> } => x.info !== null);
    return filter === 'all' ? list : list.filter(({ info }) => info.kind === filter);
  }, [items, filter]);

  // Verify each uploaded item's encrypted manifest (and decrypt its thumbnail) — no chunk is downloaded.
  const blobIds = useMemo(
    () => items.map((i) => mediaInfoFromItem(i)?.blob_id).filter((id): id is string => !!id && isUploadedBlobId(id)),
    [items],
  );
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    (async () => {
      for (const blobId of blobIds) {
        if (cancelled || manifests[blobId] || metaErrors[blobId]) continue;
        try {
          const meta = await loadMediaMetadata({ api, blobId, withVaultKey });
          if (cancelled) { if (meta.thumbnailUrl) URL.revokeObjectURL(meta.thumbnailUrl); return; }
          setManifests((m) => ({ ...m, [blobId]: meta.manifest }));
          if (meta.thumbnailUrl) { thumbRef.current[blobId] = meta.thumbnailUrl; setThumbs((t) => ({ ...t, [blobId]: meta.thumbnailUrl as string })); }
        } catch (e) {
          if (!cancelled) setMetaErrors((m) => ({ ...m, [blobId]: e instanceof Error ? e.message : String(e) }));
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, blobIds]);
  // Release decrypted thumbnails when the view goes away.
  useEffect(() => () => { Object.values(thumbRef.current).forEach((u) => URL.revokeObjectURL(u)); thumbRef.current = {}; }, []);

  const onUpload = useCallback(async (file: File) => {
    if (!api) return;
    setError(null); setNotice(null); setBusy(`Encrypting and uploading ${file.name}…`);
    try {
      const { item, warning } = await uploadMediaFile({
        api, file, withVaultKey,
        makeEncryptedMetadataB64: () => encryptWithVaultKey(JSON.stringify({ name: 'My vault' })),
      });
      await upsertItem(item);
      onItemsChanged?.();
      setNotice(`Uploaded “${file.name}” as encrypted chunks.${warning ? ' ' + warning : ''}`);
    } catch (e) {
      setError(`Upload failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }, [api, onItemsChanged]);

  const onDownload = useCallback(async (item: VaultItem) => {
    if (!api) return;
    setError(null); setNotice(null); setBusy(`Downloading and decrypting ${item.title}…`);
    try {
      const got = await downloadMediaItem({ api, item, withVaultKey });
      const url = URL.createObjectURL(new Blob([got.bytes as BlobPart], { type: got.mimeType }));
      const a = document.createElement('a');
      a.href = url; a.download = got.fileName; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setNotice(`Decrypted and verified “${got.fileName}” (${formatBytes(got.bytes.length)})${got.sha256Matches ? '; SHA-256 matches.' : '.'}`);
    } catch (e) {
      setError(`Download failed — nothing was saved: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }, [api]);

  const header = (
    <div className="mb-4">
      {api ? (
        <div className="flex flex-wrap items-center gap-3">
          <label className="btn-primary cursor-pointer text-sm" htmlFor="media-upload-input">Upload encrypted file…</label>
          <input
            id="media-upload-input" ref={fileInput} data-testid="media-upload-input" type="file" className="sr-only"
            disabled={busy !== null}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onUpload(f); }}
          />
          <span className="text-xs text-zinc-500">Encrypted on this device before upload · max {formatBytes(MAX_MEDIA_BYTES)} per file</span>
        </div>
      ) : (
        <p role="note" className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
          Local-only: file upload and download need an account server. Set the API base URL in Settings and sign in. Until then no file bytes are stored anywhere.
        </p>
      )}
      {busy && <p role="status" className="mt-2 text-xs text-zinc-300">{busy}</p>}
      {notice && <p role="status" className="mt-2 text-xs text-emerald-400">{notice}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );

  if (mediaItems.length === 0) {
    return (
      <div className="p-5">
        {header}
        <div className="text-center">
          <p className="text-zinc-400">No media or documents yet.</p>
          <p className="mt-1 text-xs text-zinc-500">
            Uploaded files are split into authenticated encrypted chunks on this device; thumbnails are generated and encrypted here too.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-5">
      {header}
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter media">
        {(['all', 'photo', 'video', 'audio', 'document', 'other'] as const).map((k) => (
          <button key={k} onClick={() => setFilter(k)} aria-pressed={filter === k} className={`rounded-full px-3 py-1 text-xs ${filter === k ? 'bg-indigo-600 text-white' : 'bg-zinc-800 text-zinc-300'}`}>
            {k === 'all' ? 'All' : k[0].toUpperCase() + k.slice(1)}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {mediaItems.map(({ item, info }) => {
          const manifest = manifests[info.blob_id];
          const uploaded = isUploadedBlobId(info.blob_id);
          const metaError = metaErrors[info.blob_id];
          const status = !uploaded ? 'missing' : metaError ? 'tampered' : manifestStatus(manifest);
          const thumb = thumbs[info.blob_id];
          const supported = isSupportedMime(info.mime_type);
          return (
            <article key={item.id} className="card overflow-hidden" aria-label={`Media item ${item.title}`}>
              <button className="block w-full text-left" onClick={() => onSelect?.(item)} disabled={status === 'tampered'}>
                <div className="flex h-28 items-center justify-center bg-zinc-900 text-4xl" aria-hidden="true">
                  {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : KIND_ICON[info.kind] ?? '📦'}
                </div>
                <div className="p-3">
                  <h3 className="truncate text-sm font-semibold text-zinc-100">{item.title}</h3>
                  <p className="mt-1 text-xs text-zinc-400">
                    {info.mime_type} · {formatBytes(info.size_bytes)}
                    {info.width && info.height ? ` · ${info.width}×${info.height}` : ''}
                    {info.duration_s != null ? ` · ${formatDuration(info.duration_s)}` : ''}
                  </p>
                  <p className="mt-1 text-xs">
                    <span className={status === 'verified' ? 'text-emerald-400' : status === 'tampered' ? 'text-red-400' : 'text-zinc-500'}>
                      Manifest: {status === 'tampered' && metaError ? 'FAILED verification' : status === 'missing' ? 'not uploaded' : api ? status : 'unknown (no account server)'}
                    </span>
                    {manifest ? ` · ${manifest.chunks.length} chunk${manifest.chunks.length > 1 ? 's' : ''}` : ''}
                  </p>
                  {!supported && <p className="mt-1 text-xs text-amber-400">Unsupported type for in-app preview — download only.</p>}
                  {status === 'tampered' && <p role="alert" className="mt-1 text-xs text-red-400">Manifest failed verification{metaError ? `: ${metaError}` : ''}. Do not open this file.</p>}
                  {status === 'missing' && <p className="mt-1 text-xs text-amber-400">This item was created with the old manifest-only form: no file bytes were ever stored, so there is nothing to download.</p>}
                  {info.kind === 'video' && manifest && (
                    <p className="mt-1 text-xs text-zinc-500">{seekChunksLabel(manifest, 0)} — video seeks fetch only the needed chunks.</p>
                  )}
                </div>
              </button>
              <div className="flex gap-2 border-t border-zinc-800 px-3 py-2">
                <button className="btn-ghost !py-1 text-xs" disabled={!api || status === 'tampered' || status === 'missing' || busy !== null} onClick={() => void onDownload(item)}>Download decrypted</button>
              </div>
            </article>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-zinc-500">
        Thumbnails are generated on this device and stored only inside the encrypted manifest; the server never sees them. Preview plaintext lives only in RAM while displayed — release it on lock. A fully compromised device is not protected by this.
      </p>
    </div>
  );
}
