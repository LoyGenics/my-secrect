import { useEffect, useState } from 'react';
import type { VaultItem } from '../../../../packages/core/src/types';
import { generateTotp, isValidBase32Secret, type TotpResult } from '../utils/totp';
import { isFavorite, isTrashed } from '../utils/password';
import { renderMarkdownToHtml } from '../utils/markdown';
import { getPasswordHistory, getNoteRevisions, isArchived } from '../utils/itemMeta';

/**
 * favorite / deleted_at are part of the VaultItem contract in the task spec
 * but are not yet declared in packages/core/src/types.ts on disk; access them
 * through these helpers so this code keeps working once the type gains them.
 */

interface ItemDetailProps {
  item: VaultItem | null;
  allItems: VaultItem[];
  onEdit: (item: VaultItem) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onClose: () => void;
  onSelectRelated?: (id: string) => void;
  /** Archive / unarchive (moves the item to / from the Archived view). */
  onArchive?: (id: string) => void;
  /** Restore a secure-note revision as the current body. */
  onRestoreRevision?: (item: VaultItem) => void;
}

const SENSITIVE_KEYS = new Set(['password', 'private_key', 'key', 'totp_secret']);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key) || /secret/i.test(key);
}

/** CVV / PIN / CVC values are never displayed, even if present in fields. */
function isForbiddenKey(key: string): boolean {
  return /^(cvv|cvc|pin)$/i.test(key);
}

function fieldString(item: VaultItem, key: string): string {
  const v = item.fields?.[key];
  return typeof v === 'string' ? v : '';
}

function prettyLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export default function ItemDetail({
  item,
  allItems,
  onEdit,
  onDelete,
  onRestore,
  onToggleFavorite,
  onClose,
  onSelectRelated,
  onArchive,
  onRestoreRevision,
}: ItemDetailProps) {
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [totp, setTotp] = useState<TotpResult | null>(null);

  const itemId = item?.id ?? null;
  const totpSecret = item?.type === 'login' && item ? fieldString(item, 'totp_secret') : '';
  const totpValid = totpSecret !== '' && isValidBase32Secret(totpSecret);

  // Live TOTP code, refreshed every second while a valid secret is present.
  useEffect(() => {
    if (!totpValid) {
      setTotp(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      const result = await generateTotp(totpSecret);
      if (!cancelled) setTotp(result);
    };
    void tick();
    const timer = setInterval(() => {
      void tick();
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [itemId, totpSecret, totpValid]);

  // Reset per-item UI state when the selected item changes.
  useEffect(() => {
    setRevealed({});
    setCopiedKey(null);
  }, [itemId]);

  if (!item) {
    return <p>Select an item to view its details.</p>;
  }

  const trashed = isTrashed(item);
  const favorite = isFavorite(item);

  const handleCopy = async (key: string, text: string) => {
    if (await copyText(text)) {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1500);
    }
  };

  // Meta fields get their own sections below — never rendered as raw JSON.
  const META_KEYS = new Set(['password_history', 'revisions', 'archived', 'parent_id']);
  const fieldEntries = Object.entries(item.fields ?? {}).filter(
    ([key]) => !isForbiddenKey(key) && !META_KEYS.has(key),
  );
  const archived = isArchived(item);
  const passwordHistory = item.type === 'login' ? getPasswordHistory(item) : [];
  const revisions = item.type === 'secure_note' ? getNoteRevisions(item) : [];
  const parentId = typeof item.fields?.parent_id === 'string' ? (item.fields.parent_id as string) : '';
  const parent = parentId ? allItems.find((c) => c.id === parentId) : undefined;
  const children =
    item.type === 'collection'
      ? allItems.filter((c) => typeof c.fields?.parent_id === 'string' && c.fields.parent_id === item.id)
      : [];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ flex: 1, margin: 0 }}>{item.title}</h2>
        <button type="button" onClick={onClose} aria-label="Close details">✕</button>
      </div>
      <p style={{ color: '#666', margin: '4px 0' }}>
        {item.type}
        {favorite ? ' · ★ Favorite' : ''}
        {trashed ? ' · In trash' : ''}
        {archived ? ' · 📦 Archived' : ''}
      </p>
      {parent && (
        <p style={{ margin: '4px 0' }}>
          <small>
            In collection:{' '}
            {onSelectRelated ? (
              <button type="button" onClick={() => onSelectRelated(parent.id)} style={{ padding: 0, background: 'none', border: 'none', color: '#1a73e8', cursor: 'pointer', textDecoration: 'underline' }}>
                {parent.title}
              </button>
            ) : (
              <span>{parent.title}</span>
            )}
          </small>
        </p>
      )}
      {trashed && (
        <p role="alert" style={{ color: '#c0392b' }}>This item is in the trash.</p>
      )}
      {item.tags.length > 0 && (
        <p>
          {item.tags.map((tag) => (
            <span
              key={tag}
              style={{
                display: 'inline-block',
                background: '#f0f0f0',
                borderRadius: 10,
                padding: '0 8px',
                marginRight: 4,
                fontSize: 12,
              }}
            >
              {tag}
            </span>
          ))}
        </p>
      )}

      <dl>
        {fieldEntries.map(([key, value]) => {
          const text = formatValue(value);
          const sensitive = isSensitiveKey(key);
          const isRevealed = Boolean(revealed[key]);
          return (
            <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0', borderBottom: '1px solid #f0f0f0' }}>
              <dt style={{ width: 140, flexShrink: 0, color: '#555' }}>{prettyLabel(key)}</dt>
              <dd style={{ flex: 1, margin: 0, wordBreak: 'break-all' }}>
                {item.type === 'secure_note' && key === 'body' ? (
                  <div dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(text) }} />
                ) : sensitive && !isRevealed ? (
                  '••••••••'
                ) : (
                  text
                )}
              </dd>
              {sensitive && (
                <button type="button" onClick={() => setRevealed((prev) => ({ ...prev, [key]: !prev[key] }))}>
                  {isRevealed ? 'Hide' : 'Show'}
                </button>
              )}
              <button type="button" onClick={() => handleCopy(`field:${key}`, text)}>
                {copiedKey === `field:${key}` ? 'Copied' : 'Copy'}
              </button>
            </div>
          );
        })}
      </dl>

      {item.type === 'login' && totpSecret !== '' && (
        <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginTop: 12 }}>
          <strong>One-time code (TOTP)</strong>
          {!totpValid ? (
            <p style={{ color: '#c0392b', margin: '6px 0 0' }}>Invalid TOTP secret.</p>
          ) : totp ? (
            <div style={{ marginTop: 6 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <code style={{ fontSize: 24, letterSpacing: 4 }}>{totp.code}</code>
                <button type="button" onClick={() => handleCopy('totp', totp.code)}>
                  {copiedKey === 'totp' ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div style={{ height: 6, background: '#eee', borderRadius: 3, marginTop: 8, overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${(totp.secondsRemaining / totp.period) * 100}%`,
                    background: totp.secondsRemaining <= 5 ? '#c0392b' : '#27ae60',
                  }}
                />
              </div>
              <small>{totp.secondsRemaining}s remaining</small>
            </div>
          ) : (
            <p style={{ margin: '6px 0 0' }}>Loading code…</p>
          )}
        </div>
      )}

      {(item.type === 'media' || item.type === 'document') && fieldString(item, 'sha256') && (
        <p><small>Manifest only — file bytes are not stored in this local prototype.</small></p>
      )}

      {passwordHistory.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ margin: '0 0 4px' }}>Previous passwords</h3>
          <p style={{ margin: '0 0 8px' }}><small>Kept encrypted with this item (max 5). The current password is above.</small></p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {passwordHistory.map((entry, i) => {
              const key = `history:${i}`;
              const shown = Boolean(revealed[key]);
              return (
                <li key={i} style={{ marginBottom: 4 }}>
                  {shown ? <code style={{ wordBreak: 'break-all' }}>{entry.password}</code> : '••••••••'}{' '}
                  <small>· changed {formatDate(entry.changed_at)}</small>{' '}
                  <button type="button" onClick={() => setRevealed((prev) => ({ ...prev, [key]: !prev[key] }))}>
                    {shown ? 'Hide' : 'Show'}
                  </button>{' '}
                  <button type="button" onClick={() => void handleCopy(key, entry.password)}>
                    {copiedKey === key ? 'Copied' : 'Copy'}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {revisions.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ margin: '0 0 4px' }}>Note revisions</h3>
          <p style={{ margin: '0 0 8px' }}><small>Previous versions of this note (max 10), kept encrypted with the item.</small></p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {revisions.map((rev, i) => (
              <li key={i} style={{ marginBottom: 8 }}>
                <div><small>Saved {formatDate(rev.saved_at)}</small></div>
                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{rev.body.slice(0, 200)}{rev.body.length > 200 ? '…' : ''}</div>
                {onRestoreRevision && (
                  <button
                    type="button"
                    onClick={() => onRestoreRevision({ ...item, fields: { ...item.fields, body: rev.body } })}
                  >
                    Restore this version
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {children.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ margin: '0 0 4px' }}>Inside this collection</h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {children.map((child) => (
              <li key={child.id}>
                {onSelectRelated ? (
                  <button type="button" onClick={() => onSelectRelated(child.id)} style={{ padding: 0, background: 'none', border: 'none', color: '#1a73e8', cursor: 'pointer', textDecoration: 'underline' }}>
                    {child.title} <small>({child.type})</small>
                  </button>
                ) : (
                  <span>{child.title} <small>({child.type})</small></span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <h3 style={{ margin: '0 0 4px' }}>Relations</h3>
        {item.relations.length === 0 ? (
          <p style={{ margin: 0 }}>No relations.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {item.relations.map((rel) => {
              const target = allItems.find((candidate) => candidate.id === rel.target_id);
              return (
                <li key={rel.target_id}>
                  {target ? (
                    onSelectRelated ? (
                      <button type="button" onClick={() => onSelectRelated(target.id)} style={{ padding: 0, background: 'none', border: 'none', color: '#1a73e8', cursor: 'pointer', textDecoration: 'underline' }}>
                        {target.title} <small>({target.type})</small>
                      </button>
                    ) : (
                      <span>{target.title} <small>({target.type})</small></span>
                    )
                  ) : (
                    <span>{rel.target_id} <small>(not found)</small></span>
                  )}
                  {' '}<small>· {rel.type}</small>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        <h3 style={{ margin: '0 0 4px' }}>Attachments</h3>
        {item.attachments.length === 0 ? (
          <p style={{ margin: 0 }}>No attachments.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {item.attachments.map((attachment) => (
              <li key={attachment}><code>{attachment}</code></li>
            ))}
          </ul>
        )}
      </div>

      <p style={{ color: '#666', marginTop: 16 }}>
        <small>
          Created: {formatDate(item.created_at)}
          <br />
          Updated: {formatDate(item.updated_at)}
        </small>
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <button type="button" onClick={() => onEdit(item)}>Edit</button>
        <button type="button" onClick={() => onToggleFavorite(item.id)}>
          {favorite ? '★ Unfavorite' : '☆ Favorite'}
        </button>
        {!trashed && onArchive && (
          <button type="button" onClick={() => onArchive(item.id)}>
            {archived ? '📦 Unarchive' : '📦 Archive'}
          </button>
        )}
        {trashed ? (
          <button type="button" onClick={() => onRestore(item.id)}>Restore</button>
        ) : (
          <button type="button" onClick={() => onDelete(item.id)}>Delete</button>
        )}
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
