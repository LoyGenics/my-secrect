import { useMemo, useState } from 'react';
import type { VaultItem } from '../../../packages/core/src/types';
import type { BlobManifest } from '../../../packages/storage/src/upload';
import {
  mediaInfoFromItem,
  formatBytes,
  formatDuration,
  manifestStatus,
  seekChunksLabel,
  isSupportedMime,
} from '../utils/media';

/**
 * MediaView — NEW FILE, does not modify App.tsx (another agent owns it).
 * App.tsx can render <MediaView items={...} manifests={...} /> as a view
 * when it chooses; this component is complete on its own.
 *
 * What it shows, and what it deliberately does NOT fake:
 *  - Encrypted media metadata only: mime type, size, dimensions,
 *    duration, blob id, chunk count. File bytes are never in this view.
 *  - Thumbnails: shown ONLY when the caller passes a decrypted object
 *    URL (`thumbnailUrls[blobId]`). Otherwise the tile says "Thumbnail
 *    encrypted" — no placeholder image is invented, and no thumbnail is
 *    ever fetched from the server in plaintext.
 *  - Manifest status per item: verified / missing / tampered / unknown
 *    (see utils/media.ts). A tampered manifest is shown as an error and
 *    its item cannot be opened from here.
 *  - Video range note: seeking maps to chunk numbers (range fetch +
 *    per-chunk decrypt), so playback does not need the whole file.
 *  - Preview plaintext exists only in RAM while displayed; the note
 *    under the grid says so, and callers must revoke object URLs on
 *    unmount / lock.
 */

export interface MediaViewProps {
  items: VaultItem[];
  /** Decrypted manifests, keyed by blob id. Absent = not synced / not uploaded yet. */
  manifests?: Record<string, BlobManifest>;
  /** Decrypted thumbnail object URLs, keyed by blob id. Absent = encrypted. */
  thumbnailUrls?: Record<string, string>;
  onSelect?: (item: VaultItem) => void;
  onRequestDownload?: (item: VaultItem) => void;
}

const KIND_ICON: Record<string, string> = {
  photo: '🖼️',
  video: '🎬',
  audio: '🎵',
  document: '📄',
  other: '📦',
};

export default function MediaView({ items, manifests = {}, thumbnailUrls = {}, onSelect, onRequestDownload }: MediaViewProps) {
  const [filter, setFilter] = useState<'all' | 'photo' | 'video' | 'document' | 'other'>('all');
  const mediaItems = useMemo(() => {
    const list = items
      .map((item) => ({ item, info: mediaInfoFromItem(item) }))
      .filter((x): x is { item: VaultItem; info: NonNullable<ReturnType<typeof mediaInfoFromItem>> } => x.info !== null);
    return filter === 'all' ? list : list.filter(({ info }) => info.kind === filter || (filter === 'document' && info.kind === 'document'));
  }, [items, filter]);

  if (mediaItems.length === 0) {
    return (
      <div className="p-5 text-center">
        <p className="text-zinc-400">No media or documents yet.</p>
        <p className="mt-1 text-xs text-zinc-500">
          Add a media item — its file is split into authenticated encrypted chunks before upload, and its thumbnail is generated and encrypted on this device.
        </p>
      </div>
    );
  }

  return (
    <div className="p-5">
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter media">
        {(['all', 'photo', 'video', 'document', 'other'] as const).map((k) => (
          <button key={k} onClick={() => setFilter(k)} aria-pressed={filter === k} className={`rounded-full px-3 py-1 text-xs ${filter === k ? 'bg-indigo-600 text-white' : 'bg-zinc-800 text-zinc-300'}`}>
            {k === 'all' ? 'All' : k[0].toUpperCase() + k.slice(1)}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {mediaItems.map(({ item, info }) => {
          const manifest = manifests[info.blob_id];
          const status = manifestStatus(manifest);
          const thumb = thumbnailUrls[info.blob_id];
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
                      Manifest: {status}
                    </span>
                    {manifest ? ` · ${manifest.chunks.length} chunk${manifest.chunks.length > 1 ? 's' : ''}` : ''}
                  </p>
                  {!supported && <p className="mt-1 text-xs text-amber-400">Unsupported type for in-app preview — download only.</p>}
                  {status === 'tampered' && <p className="mt-1 text-xs text-red-400">Manifest failed verification. Do not open this file.</p>}
                  {info.kind === 'video' && manifest && (
                    <p className="mt-1 text-xs text-zinc-500">{seekChunksLabel(manifest, 0)} — video seeks fetch only the needed chunks.</p>
                  )}
                </div>
              </button>
              <div className="flex gap-2 border-t border-zinc-800 px-3 py-2">
                <button className="btn-ghost !py-1 text-xs" disabled={status === 'tampered'} onClick={() => onRequestDownload?.(item)}>Download decrypted</button>
              </div>
            </article>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-zinc-500">
        Thumbnails are generated and encrypted on this device; the server never sees them. Preview plaintext lives only in RAM while displayed — release it on lock. A fully compromised device is not protected by this.
      </p>
    </div>
  );
}
