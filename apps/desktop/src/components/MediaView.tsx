import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VaultItem } from '../../../../packages/core/src/types';
import type { BlobManifest } from '../../../../packages/storage/src/upload';
import { BlobUploadError, webStorageResumeStore } from '../../../../packages/storage/src/upload';
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
  loadThumbnailUrl,
  MAX_MEDIA_BYTES,
  type MediaApi,
  type MediaInfo,
  type MediaKind,
} from '../utils/media';
import { upsertItem, withVaultKey, encryptWithVaultKey } from '../vault';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { format, plural, type Dictionary } from '../../../../packages/i18n/src/index';

/**
 * MediaView — encrypted file upload / download / gallery / viewer.
 *
 *  - Upload: the chosen file is read and encrypted ON THIS DEVICE one 1 MiB
 *    chunk at a time (per-file random File Key, XChaCha20-Poly1305 v1); the
 *    manifest (name, type, size, chunk hashes, wrapped File Key) is
 *    encrypted with the Vault Key, and only ciphertext goes to object
 *    storage through presigned URLs. Progress is shown per part. An
 *    interrupted upload is remembered (no plaintext, no key — see
 *    utils/media.ts) and resumes when the same file is chosen again.
 *  - Thumbnails are generated here, encrypted and uploaded as their own
 *    blob. The gallery loads and decrypts each tile's thumbnail (and
 *    verifies its manifest) only when the tile scrolls into view.
 *  - View / Download: every chunk is verified against the authenticated
 *    manifest before it is decrypted, and the decrypted file is handed to
 *    the viewer or the browser only after ALL checks passed. Any failure is
 *    shown as an error and nothing is shown or saved. Decrypted bytes live
 *    in memory only; every object URL is revoked when the viewer closes,
 *    after a download was handed over, and on unmount.
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

type Filter = 'all' | MediaKind;
const FILTERS: Filter[] = ['all', 'photo', 'video', 'audio', 'document', 'other'];

/** One consistent stroke icon set for the kinds (no emoji stand-ins). */
function KindIcon({ kind, className = 'h-8 w-8' }: { kind: MediaKind; className?: string }) {
  const common = { className, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (kind) {
    case 'photo':
      return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.75" /><path d="m21 16-5-5-8 9" /></svg>;
    case 'video':
      return <svg {...common}><rect x="3" y="5" width="13" height="14" rx="2" /><path d="m16 10 5-3v10l-5-3" /></svg>;
    case 'audio':
      return <svg {...common}><path d="M9 18V6l11-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="17.5" cy="16" r="2.5" /></svg>;
    case 'document':
      return <svg {...common}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></svg>;
    default:
      return <svg {...common}><path d="m21 8-9-5-9 5 9 5z" /><path d="M3 8v8l9 5 9-5V8M12 13v8" /></svg>;
  }
}

/** Can this browser show the decrypted file in-app? (images by type; audio/video asked of the element). */
function previewSupport(info: MediaInfo, m: Dictionary['media']): { ok: boolean; reason?: string } {
  if (info.kind === 'photo') return isSupportedMime(info.mime_type) ? { ok: true } : { ok: false, reason: format(m.notPreviewed, info.mime_type) };
  if (info.kind !== 'video' && info.kind !== 'audio') return { ok: false, reason: m.noPreviewType };
  if (typeof document === 'undefined') return { ok: false, reason: m.noMediaElement };
  const can = document.createElement(info.kind).canPlayType(info.mime_type);
  return can ? { ok: true } : { ok: false, reason: format(m.cannotPlay, info.mime_type) };
}

/** Runs at most `limit` decrypt jobs at a time so a long gallery does not fire every request at once. */
function useLimiter(limit: number) {
  const active = useRef(0);
  const queue = useRef<Array<() => void>>([]);
  return useCallback(<T,>(job: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const run = () => {
      active.current++;
      job().then(resolve, reject).finally(() => {
        active.current--;
        queue.current.shift()?.();
      });
    };
    if (active.current < limit) run(); else queue.current.push(run);
  }), [limit]);
}

interface UploadState {
  fileName: string;
  done: number;
  total: number;
  resumedParts: number;
  retry?: string;
}

interface ViewerState {
  item: VaultItem;
  info: MediaInfo;
  status: 'decrypting' | 'ready' | 'failed';
  done: number;
  total: number;
  url?: string;
  error?: string;
}

export default function MediaView({ items, api = null, onItemsChanged, onSelect }: MediaViewProps) {
  const { dict, locale } = useTranslation();
  const m = dict.media;
  const [filter, setFilter] = useState<Filter>('all');
  const [manifests, setManifests] = useState<Record<string, BlobManifest>>({});
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [metaErrors, setMetaErrors] = useState<Record<string, string>>({});
  const [thumbErrors, setThumbErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [interrupted, setInterrupted] = useState<{ file: File; stored: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const urlsRef = useRef<Set<string>>(new Set());
  const requested = useRef<Set<string>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const limit = useLimiter(3);
  const resumeStore = useMemo(() => (typeof localStorage === 'undefined' ? undefined : webStorageResumeStore(localStorage)), []);

  const mediaItems = useMemo(() => {
    const list = items
      .map((item) => ({ item, info: mediaInfoFromItem(item) }))
      .filter((x): x is { item: VaultItem; info: MediaInfo } => x.info !== null);
    return filter === 'all' ? list : list.filter(({ info }) => info.kind === filter);
  }, [items, filter]);

  // Release every decrypted object URL (thumbnails, viewer) when the view goes away.
  useEffect(() => () => { urlsRef.current.forEach((u) => URL.revokeObjectURL(u)); urlsRef.current.clear(); }, []);

  const track = (url: string) => { urlsRef.current.add(url); return url; };
  const release = (url: string | undefined) => { if (!url) return; URL.revokeObjectURL(url); urlsRef.current.delete(url); };

  /** A tile scrolled into view: verify its manifest and decrypt its thumbnail (once). */
  const loadTile = useCallback((info: MediaInfo) => {
    if (!api || !isUploadedBlobId(info.blob_id) || requested.current.has(info.blob_id)) return;
    requested.current.add(info.blob_id);
    void limit(() => loadMediaMetadata({ api, blobId: info.blob_id, withVaultKey }))
      .then((meta) => {
        setManifests((m) => ({ ...m, [info.blob_id]: meta.manifest }));
        if (meta.thumbnailUrl) setThumbs((t) => ({ ...t, [info.blob_id]: track(meta.thumbnailUrl as string) }));
      })
      .catch((e) => setMetaErrors((m) => ({ ...m, [info.blob_id]: e instanceof Error ? e.message : String(e) })));
    if (info.thumbnail_blob_id) {
      const thumbId = info.thumbnail_blob_id;
      void limit(() => loadThumbnailUrl({ api, thumbnailBlobId: thumbId, withVaultKey }))
        .then((url) => setThumbs((t) => ({ ...t, [info.blob_id]: track(url) })))
        .catch((e) => setThumbErrors((m) => ({ ...m, [info.blob_id]: e instanceof Error ? e.message : String(e) })));
    }
  }, [api, limit]);

  const onUpload = useCallback(async (file: File) => {
    if (!api) return;
    setError(null); setNotice(null); setInterrupted(null);
    setUpload({ fileName: file.name, done: 0, total: Math.max(1, Math.ceil(file.size / (1024 * 1024))), resumedParts: 0 });
    try {
      const { item, warning, resumedParts } = await uploadMediaFile({
        api, file, withVaultKey, resumeStore,
        makeEncryptedMetadataB64: () => encryptWithVaultKey(JSON.stringify({ name: 'My vault' })),
        transfer: {
          onProgress: (done, total) => setUpload((u) => u && { ...u, done, total, retry: undefined }),
          onRetry: (r) => setUpload((u) => u && { ...u, retry: format(m.retryPart, r.partNumber, r.error.split(' — ')[0], (r.delayMs / 1000).toFixed(1)) }),
        },
      });
      await upsertItem(item);
      onItemsChanged?.();
      const resumed = resumedParts ? ` ${plural(locale, m.resumed, resumedParts)}` : '';
      setNotice(`${format(m.uploaded, file.name)}${resumed}${warning ? ' ' + warning : ''}`);
    } catch (e) {
      if (e instanceof BlobUploadError) {
        const total = Math.max(1, Math.ceil(file.size / (1024 * 1024)));
        setInterrupted({ file, stored: total - e.missingParts.length, total });
        setError(format(m.interrupted, total - e.missingParts.length, total));
      } else {
        setError(format(m.uploadFailed, e instanceof Error ? e.message : String(e)));
      }
    } finally {
      setUpload(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }, [api, onItemsChanged, resumeStore, m, locale]);

  const onDownload = useCallback(async (item: VaultItem) => {
    if (!api) return;
    setError(null); setNotice(null); setBusy(format(m.downloading, item.title));
    try {
      const got = await downloadMediaItem({ api, item, withVaultKey });
      const url = URL.createObjectURL(got.blob);
      const a = document.createElement('a');
      a.href = url; a.download = got.fileName; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000); // the browser has taken the file by then
      setNotice(format(m.downloaded, got.fileName, formatBytes(got.blob.size), got.sha256Matches ? m.sha256Matches : '.'));
    } catch (e) {
      setError(format(m.downloadFailed, e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  }, [api, m]);

  const closeViewer = useCallback(() => {
    setViewer((v) => { release(v?.url); return null; });
    if (dialogRef.current?.open) dialogRef.current.close();
  }, []);

  const onView = useCallback(async (item: VaultItem, info: MediaInfo) => {
    if (!api) return;
    setError(null); setNotice(null);
    setViewer({ item, info, status: 'decrypting', done: 0, total: 0 });
    dialogRef.current?.showModal();
    try {
      const got = await downloadMediaItem({
        api, item, withVaultKey,
        transfer: { onProgress: (done, total) => setViewer((v) => v && v.item.id === item.id ? { ...v, done, total } : v) },
      });
      const url = track(URL.createObjectURL(got.blob));
      setViewer((v) => {
        if (!v || v.item.id !== item.id) { release(url); return v; } // closed while decrypting
        return { ...v, status: 'ready', url };
      });
    } catch (e) {
      setViewer((v) => v && v.item.id === item.id ? { ...v, status: 'failed', error: e instanceof Error ? e.message : String(e) } : v);
    }
  }, [api]);

  const header = (
    <div className="mb-5">
      {api ? (
        <div className="flex flex-wrap items-center gap-3">
          <label className={`btn-primary cursor-pointer text-sm ${upload || busy ? 'pointer-events-none opacity-50' : ''}`} htmlFor="media-upload-input">{m.upload}</label>
          <input
            id="media-upload-input" ref={fileInput} data-testid="media-upload-input" type="file" className="sr-only"
            disabled={upload !== null || busy !== null}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onUpload(f); }}
          />
          <span className="text-xs text-ms-muted">{format(m.uploadHint, formatBytes(MAX_MEDIA_BYTES))}</span>
        </div>
      ) : (
        <p role="note" className="rounded-lg border border-ms-warn-line bg-ms-warn-bg p-3 text-xs text-ms-warn-text">
          {m.localOnly}
        </p>
      )}
      {upload && (
        <div className="mt-3 max-w-xl" role="status" aria-live="polite">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="truncate text-ms-text">{format(m.uploading, upload.fileName)}</span>
            <span className="shrink-0 tabular-nums text-ms-muted">{format(m.parts, upload.done, upload.total)}</span>
          </div>
          <div
            className="mt-1.5 h-1 overflow-hidden rounded-full bg-ms-sunken" role="progressbar" aria-label={format(m.uploadProgress, upload.fileName)}
            aria-valuemin={0} aria-valuemax={upload.total} aria-valuenow={upload.done}
          >
            <div className="h-full rounded-full bg-[var(--ms-color-brand)] transition-[width] duration-200 ease-out" style={{ width: `${(100 * upload.done) / upload.total}%` }} />
          </div>
          {upload.retry && <p className="mt-1.5 text-xs text-[var(--ms-color-warning-text)]">{upload.retry}</p>}
        </div>
      )}
      {busy && <p role="status" className="mt-3 text-xs text-ms-muted">{busy}</p>}
      {notice && <p role="status" className="mt-3 text-xs text-[var(--ms-color-success-text)]">{notice}</p>}
      {error && (
        <div role="alert" className="mt-3 flex max-w-xl flex-wrap items-center gap-3 rounded-lg border border-[var(--ms-color-danger-border)] bg-[var(--ms-color-danger-soft)] px-3 py-2 text-xs text-[var(--ms-color-danger-soft-text)]">
          <span className="min-w-0 flex-1">{error}</span>
          {interrupted && (
            <button className="btn-ghost !py-1 text-xs" disabled={upload !== null} onClick={() => void onUpload(interrupted.file)}>
              {m.resume}
            </button>
          )}
        </div>
      )}
    </div>
  );

  const viewerDialog = (
    <dialog
      ref={dialogRef}
      aria-label={viewer ? format(m.viewerTitle, viewer.item.title) : m.viewer}
      onClose={closeViewer}
      onClick={(e) => { if (e.target === e.currentTarget) closeViewer(); }}
      className="w-[min(92vw,64rem)] overflow-hidden rounded-xl border border-ms-line bg-ms-surface2 p-0 text-ms-text shadow-2xl backdrop:bg-black/70"
    >
      {viewer && (
        <div className="flex max-h-[88vh] flex-col">
          <div className="flex items-center gap-3 border-b border-ms-line px-4 py-3">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold">{viewer.item.title}</h2>
              <p className="text-xs text-ms-muted">
                {viewer.info.mime_type} · {formatBytes(viewer.info.size_bytes)}
                {viewer.status === 'ready' && <span className="text-[var(--ms-color-success-text)]">{` · ${m.verifiedDecrypted}`}</span>}
              </p>
            </div>
            <button className="btn-ghost !py-1 text-xs" onClick={closeViewer} autoFocus>{dict.common.close}</button>
          </div>
          <div className="flex min-h-[16rem] flex-1 items-center justify-center overflow-auto bg-black/40 p-4">
            {viewer.status === 'decrypting' && (
              <div className="w-full max-w-sm text-center" role="status" aria-live="polite">
                <p className="text-sm text-ms-muted">{m.verifying}</p>
                <p className="mt-1 text-xs tabular-nums text-ms-muted">{viewer.total ? format(m.chunksProgress, viewer.done, viewer.total) : m.fetchingManifest}</p>
                <div className="mt-3 h-1 overflow-hidden rounded-full bg-ms-sunken">
                  <div className="h-full rounded-full bg-[var(--ms-color-brand)] transition-[width] duration-200 ease-out" style={{ width: viewer.total ? `${(100 * viewer.done) / viewer.total}%` : '0%' }} />
                </div>
                <p className="mt-3 text-xs text-ms-muted">{m.nothingShown}</p>
              </div>
            )}
            {viewer.status === 'failed' && (
              <p role="alert" className="max-w-md text-center text-sm text-[var(--ms-color-danger-soft-text)]">
                {format(m.couldNotOpen, viewer.error ?? '')}
              </p>
            )}
            {viewer.status === 'ready' && viewer.url && (
              viewer.info.kind === 'photo' ? <img src={viewer.url} alt={viewer.item.title} className="max-h-[72vh] max-w-full object-contain" />
                : viewer.info.kind === 'video' ? <video src={viewer.url} controls className="max-h-[72vh] max-w-full" aria-label={viewer.item.title} />
                  : <audio src={viewer.url} controls className="w-full max-w-md" aria-label={viewer.item.title} />
            )}
          </div>
        </div>
      )}
    </dialog>
  );

  if (mediaItems.length === 0 && filter === 'all') {
    return (
      <div className="p-5">
        {header}
        <div className="mx-auto mt-10 max-w-md text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl border border-ms-line bg-ms-surface2 text-ms-muted"><KindIcon kind="photo" className="h-7 w-7" /></div>
          <p className="mt-4 text-sm text-ms-text">{m.empty}</p>
          <p className="mt-1 text-xs text-ms-muted">
            {m.emptyHint}
          </p>
        </div>
        {viewerDialog}
      </div>
    );
  }

  return (
    <div className="p-5">
      {header}
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label={m.filterLabel}>
        {FILTERS.map((k) => (
          <button key={k} onClick={() => setFilter(k)} aria-pressed={filter === k} className={`rounded-full px-3 py-1 text-xs transition-colors duration-150 ${filter === k ? 'bg-ms-brand-bg text-ms-text' : 'bg-ms-sunken text-ms-muted hover:bg-ms-sunken'}`}>
            {m.filters[k === 'other' ? 'misc' : k]}
          </button>
        ))}
      </div>
      {mediaItems.length === 0 && <p className="text-sm text-ms-muted">{m.nothingInFilter}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {mediaItems.map(({ item, info }) => {
          const manifest = manifests[info.blob_id];
          const uploaded = isUploadedBlobId(info.blob_id);
          const metaError = metaErrors[info.blob_id];
          const status = !uploaded ? 'missing' : metaError ? 'tampered' : manifestStatus(manifest);
          const preview = previewSupport(info, m);
          return (
            <MediaTile
              key={item.id}
              item={item}
              info={info}
              thumb={thumbs[info.blob_id]}
              thumbError={thumbErrors[info.blob_id]}
              manifest={manifest}
              status={status}
              metaError={metaError}
              hasApi={!!api}
              busy={busy !== null || upload !== null}
              preview={preview}
              onVisible={loadTile}
              onSelect={onSelect}
              onView={() => void onView(item, info)}
              onDownload={() => void onDownload(item)}
            />
          );
        })}
      </div>
      <p className="mt-5 max-w-3xl text-xs text-ms-muted">
        {m.footnote}
      </p>
      {viewerDialog}
    </div>
  );
}

function MediaTile(props: {
  item: VaultItem;
  info: MediaInfo;
  thumb?: string;
  thumbError?: string;
  manifest?: BlobManifest;
  status: 'verified' | 'missing' | 'tampered' | 'unknown';
  metaError?: string;
  hasApi: boolean;
  busy: boolean;
  preview: { ok: boolean; reason?: string };
  onVisible: (info: MediaInfo) => void;
  onSelect?: (item: VaultItem) => void;
  onView: () => void;
  onDownload: () => void;
}) {
  const { item, info, thumb, thumbError, manifest, status, metaError, hasApi, busy, preview, onVisible } = props;
  const { dict, locale } = useTranslation();
  const m = dict.media;
  const ref = useRef<HTMLElement>(null);
  const uploaded = isUploadedBlobId(info.blob_id);

  // Lazy: decrypt this tile's thumbnail + manifest only once it is (nearly) on screen.
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasApi || !uploaded) return;
    if (typeof IntersectionObserver === 'undefined') { onVisible(info); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { onVisible(info); io.disconnect(); }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasApi, uploaded, info, onVisible]);

  const loadingThumb = hasApi && uploaded && !thumb && !thumbError && (info.thumbnail_blob_id || !manifest) && status !== 'tampered';
  const blocked = !hasApi || status === 'tampered' || status === 'missing' || busy;

  return (
    <article ref={ref} className="card overflow-hidden" aria-label={format(m.tileLabel, item.title)}>
      <button className="group block w-full text-left focus-visible:outline-none" onClick={() => props.onSelect?.(item)} disabled={status === 'tampered'}>
        <div className={`relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-ms-surface2 text-ms-muted ${loadingThumb ? 'animate-pulse' : ''}`}>
          {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : <KindIcon kind={info.kind} />}
          {info.duration_s != null && (
            <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] tabular-nums text-white">{formatDuration(info.duration_s)}</span>
          )}
        </div>
        <div className="p-3">
          <h3 className="truncate text-sm font-semibold text-ms-text group-hover:text-ms-text">{item.title}</h3>
          <p className="mt-1 text-xs text-ms-muted">
            {info.mime_type} · {formatBytes(info.size_bytes)}
            {info.width && info.height ? ` · ${info.width}×${info.height}` : ''}
          </p>
          <p className="mt-1 text-xs">
            <span className={status === 'verified' ? 'text-[var(--ms-color-success-text)]' : status === 'tampered' ? 'text-[var(--ms-color-danger-soft-text)]' : 'text-ms-muted'}>
              {format(m.manifest, status === 'tampered' && metaError ? m.manifestFailed : status === 'missing' ? m.manifestMissing : hasApi ? m.status[status] : m.manifestUnknown)}
            </span>
            {manifest ? <span className="text-ms-muted">{` · ${plural(locale, m.chunks, manifest.chunks.length)}`}</span> : ''}
          </p>
          {thumbError && <p className="mt-1 text-xs text-[var(--ms-color-warning-text)]">{m.thumbFailed}</p>}
          {status === 'tampered' && <p role="alert" className="mt-1 text-xs text-[var(--ms-color-danger-soft-text)]">{format(m.manifestTampered, metaError ? `: ${metaError}` : '')}</p>}
          {status === 'missing' && <p className="mt-1 text-xs text-[var(--ms-color-warning-text)]">{m.legacyManifest}</p>}
          {info.kind === 'video' && manifest && (
            <p className="mt-1 text-xs text-ms-muted">{format(m.seekNote, seekChunksLabel(manifest, 0))}</p>
          )}
        </div>
      </button>
      <div className="flex flex-wrap gap-2 border-t border-ms-line px-3 py-2">
        {(info.kind === 'photo' || info.kind === 'video' || info.kind === 'audio') && (
          <button
            className="btn-ghost !py-1 text-xs" disabled={blocked || !preview.ok} onClick={props.onView}
            title={preview.ok ? undefined : format(m.downloadOnlyTitle, preview.reason ?? '')}
          >
            {m.view}
          </button>
        )}
        <button className="btn-ghost !py-1 text-xs" disabled={blocked} onClick={props.onDownload}>{m.download}</button>
      </div>
      {!preview.ok && info.kind !== 'document' && info.kind !== 'other' && (
        <p className="px-3 pb-2 text-xs text-[var(--ms-color-warning-text)]">{format(m.downloadOnly, preview.reason ?? '')}</p>
      )}
      {!isSupportedMime(info.mime_type) && (info.kind === 'document' || info.kind === 'other') && (
        <p className="px-3 pb-2 text-xs text-ms-muted">{m.noPreview}</p>
      )}
    </article>
  );
}
