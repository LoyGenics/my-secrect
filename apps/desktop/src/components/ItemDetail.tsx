import { useEffect, useState } from 'react';
import type { VaultItem } from '../../../../packages/core/src/types';
import { cardIssuer, cardLast4, formatCardNumber, isCardVerificationField } from '../../../../packages/core/src/card';
import { readLocalCardCode } from '../vault';
import { generateTotp, isValidBase32Secret, type TotpResult } from '../utils/totp';
import { isFavorite, isTrashed } from '../utils/password';
import { renderMarkdownToHtml } from '../utils/markdown';
import { getPasswordHistory, getNoteRevisions, isArchived } from '../utils/itemMeta';
import {
  Alert,
  Button,
  Card,
  DropdownMenu,
  Icon,
  IconButton,
  Progress,
  copyWithClear,
  useClipboardStatus,
  type MenuItemDef,
} from '../theme';
import TypeStamp from './TypeStamp';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { format, formatDate, plural, type Dictionary, type Locale } from '../../../../packages/i18n/src/index';

interface ItemDetailProps {
  item: VaultItem | null;
  allItems: VaultItem[];
  onEdit: (item: VaultItem) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onSelectRelated?: (id: string) => void;
  /** Archive / unarchive (moves the item to / from the Archived view). */
  onArchive?: (id: string) => void;
  /** Restore a secure-note revision as the current body. */
  onRestoreRevision?: (item: VaultItem) => void;
}

const SENSITIVE_KEYS = new Set(['password', 'private_key', 'key', 'totp_secret', 'card_number', 'cvv']);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key) || /secret/i.test(key);
}

/** CVV is loaded separately from device-local ciphertext. */
function isForbiddenKey(key: string): boolean {
  return isCardVerificationField(key) || /^pin$/i.test(key);
}

function fieldString(item: VaultItem, key: string): string {
  const v = item.fields?.[key];
  return typeof v === 'string' ? v : '';
}

function prettyLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function fieldLabel(dict: Dictionary, key: string): string {
  return (dict.fields as Record<string, string>)[key] ?? prettyLabel(key);
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function displayDate(locale: Locale, iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatDate(locale, d, { dateStyle: 'medium', timeStyle: 'short' });
}

const MASK = '••••••••';

/** "482913" -> "482 913" for reading; the copied value stays the raw code. */
function groupCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
/** Cells animated by the reveal flip; longer values (keys) show the rest at once. */
const FLIP_CELLS = 48;

/** Signature reveal: masked cells flip to characters, staggered 8 ms (instant under reduced motion). */
function Revealed({ text }: { text: string }) {
  const head = Array.from(text.slice(0, FLIP_CELLS));
  return (
    <span className="ms-reveal">
      {head.map((ch, i) => (
        <span key={i} className="ms-reveal__ch" style={{ animationDelay: `${i * 8}ms` }}>
          {ch}
        </span>
      ))}
      {text.slice(FLIP_CELLS)}
    </span>
  );
}

const SECRET_ORDER = ['password', 'card_number', 'key', 'account_number', 'document_number', 'private_key'];
const ID_ORDER = ['username', 'holder_name', 'cardholder', 'full_name', 'service', 'rp_id', 'file_name', 'bank_name'];

/**
 * Item detail: a large type tile, the title, a row of pill buttons, the
 * one-time-code card with its countdown ring, and a card of field rows that
 * each end in reveal / copy buttons. A copy shows "Copied · clears in 30s"
 * beside the value and the clipboard is cleared at the deadline (see
 * packages/ui/src/clipboard.ts). Phones get a thumb-reach action bar (copy
 * secret, copy identifier, open, more). The toolbar is the place to add the
 * share button once sharing ships.
 */
export default function ItemDetail({
  item,
  allItems,
  onEdit,
  onDelete,
  onRestore,
  onToggleFavorite,
  onSelectRelated,
  onArchive,
  onRestoreRevision,
}: ItemDetailProps) {
  const { dict, locale } = useTranslation();
  const d = dict.itemDetail;
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [totp, setTotp] = useState<TotpResult | null>(null);
  const [localCode, setLocalCode] = useState<{ id: string; value: string }>();
  const { copiedKey } = useClipboardStatus();

  const itemId = item?.id ?? null;
  const cardId = item?.type === 'card' ? item.id : undefined;
  useEffect(() => {
    if (!cardId) return;
    let active = true;
    void readLocalCardCode(cardId).then(
      (value) => { if (active) setLocalCode({ id: cardId, value }); },
      () => { if (active) setLocalCode(undefined); },
    );
    return () => { active = false; };
  }, [cardId]);
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
  }, [itemId]);

  if (!item) {
    return <p className="ms-text-muted">{d.selectPrompt}</p>;
  }

  const trashed = isTrashed(item);
  const favorite = isFavorite(item);
  const archived = isArchived(item);
  const displayTitle = item.type === 'card' ? cardIssuer(item.title, item.fields.bank) : item.title;
  const typeLabel = (dict.itemTypes as Record<string, string>)[item.type] ?? item.type;
  const copyKey = (key: string) => `${item.id}:${key}`;
  const copy = (key: string, text: string) => void copyWithClear(copyKey(key), text);
  const toggleReveal = (key: string) => setRevealed((prev) => ({ ...prev, [key]: !prev[key] }));

  // Meta fields get their own sections below — never rendered as raw JSON.
  const META_KEYS = new Set(['password_history', 'revisions', 'archived', 'parent_id']);
  const fieldEntries = Object.entries(item.fields ?? {}).filter(([key]) => {
    if (isForbiddenKey(key) || META_KEYS.has(key)) return false;
    if (item.type !== 'card') return true;
    if (key === 'bank' || (key === 'last4' && fieldString(item, 'card_number'))) return false;
    if (key === 'credit_limit' || key === 'statement_day') return fieldString(item, 'card_type') === 'credit';
    return true;
  });
  if (cardId && localCode?.id === cardId && localCode.value) fieldEntries.push(['cvv', localCode.value]);
  const passwordHistory = item.type === 'login' ? getPasswordHistory(item) : [];
  const revisions = item.type === 'secure_note' ? getNoteRevisions(item) : [];
  const parentId = typeof item.fields?.parent_id === 'string' ? (item.fields.parent_id as string) : '';
  const parent = parentId ? allItems.find((c) => c.id === parentId) : undefined;
  const children =
    item.type === 'collection'
      ? allItems.filter((c) => typeof c.fields?.parent_id === 'string' && c.fields.parent_id === item.id)
      : [];

  const secretKey = SECRET_ORDER.find((k) => fieldString(item, k));
  const idKey = ID_ORDER.find((k) => fieldString(item, k));
  const url = fieldString(item, 'url');
  const openableUrl = /^https?:\/\//i.test(url) ? url : '';

  const moreItems: MenuItemDef[] = [
    ...(!trashed && onArchive
      ? [{ key: 'archive', label: archived ? d.unarchive : d.archive, icon: (archived ? 'unarchive' : 'archive') as 'archive', onSelect: () => onArchive(item.id) }]
      : []),
    trashed
      ? { key: 'restore', label: d.restore, icon: 'restore' as const, onSelect: () => onRestore(item.id) }
      : { key: 'delete', label: d.delete, icon: 'trash' as const, danger: true, onSelect: () => onDelete(item.id) },
  ];

  const relatedButton = (target: VaultItem) =>
    onSelectRelated ? (
      <Button variant="link" onClick={() => onSelectRelated(target.id)}>
        {target.title}
      </Button>
    ) : (
      <span>{target.title}</span>
    );

  const primaryKey = trashed ? undefined : secretKey;
  const primaryCopied = primaryKey !== undefined && copiedKey === copyKey(`field:${primaryKey}`);
  const primaryLabel = primaryKey === 'password' ? d.copyPassword : primaryKey ? format(d.copy, fieldLabel(dict, primaryKey)) : '';
  const urlHost = (() => {
    try {
      return openableUrl ? new URL(openableUrl).host : url;
    } catch {
      return url;
    }
  })();
  const metaLine = [typeLabel, urlHost, archived ? d.archived : '', trashed ? d.inTrash : ''].filter(Boolean).join(' · ');
  const copyButton = (key: string, label: string, text: string) => {
    const done = copiedKey === copyKey(key);
    return <IconButton icon={done ? 'check' : 'copy'} size="sm" data-done={done} label={format(d.copy, label)} onClick={() => copy(key, text)} />;
  };

  return (
    <article className="ms-spec" aria-labelledby={`detail-title-${item.id}`}>
      <header className="ms-spec__head">
        <TypeStamp type={item.type} size="lg" />
        <div className="ms-spec__title">
          <h2 id={`detail-title-${item.id}`} className="ms-spec__name">{displayTitle}</h2>
          <p className="ms-spec__meta">{metaLine}</p>
          {parent && (
            <p className="ms-spec__meta">
              {d.inCollection}: {relatedButton(parent)}
            </p>
          )}
        </div>
        <div className="ms-spec__tools">
          <IconButton
            icon="favorite"
            size="sm"
            label={favorite ? d.unfavoriteAction : d.favoriteAction}
            aria-pressed={favorite}
            className={favorite ? 'ms-favorite--on' : undefined}
            onClick={() => onToggleFavorite(item.id)}
          />
          {!trashed && (
            <Button size="sm" variant="secondary" icon="edit" onClick={() => onEdit(item)}>
              {d.edit}
            </Button>
          )}
          <DropdownMenu label={d.more} align="end" items={moreItems} trigger={<IconButton icon="more" size="sm" label={d.more} />} />
        </div>
      </header>

      <div className="ms-spec__actions">
        {trashed ? (
          <Button variant="primary" icon="restore" onClick={() => onRestore(item.id)}>
            {d.restore}
          </Button>
        ) : primaryKey ? (
          <Button variant="primary" icon={primaryCopied ? 'check' : 'copy'} onClick={() => copy(`field:${primaryKey}`, fieldString(item, primaryKey))}>
            {primaryCopied ? dict.itemForm.copied : primaryLabel}
          </Button>
        ) : null}
        {!trashed && idKey && (
          <Button variant="secondary" icon="copy" onClick={() => copy(`field:${idKey}`, fieldString(item, idKey))}>
            {idKey === 'username' ? d.copyUsername : format(d.copy, fieldLabel(dict, idKey))}
          </Button>
        )}
      </div>

      {trashed && (
        <Alert tone="danger" announce className="mt-4">
          {d.trashedNotice}
        </Alert>
      )}

      {fieldEntries.length === 0 && !(item.type === 'login' && totpSecret !== '') ? (
        <p className="ms-text-muted">{d.noFields}</p>
      ) : (
        <ul className="ms-spec__rows" aria-label={d.fields}>
          {item.type === 'login' && totpSecret !== '' && (
            <li className="ms-spec__row ms-spec__row--totp">
              <span className="ms-spec__label">{d.totp}</span>
              <span className="ms-spec__value">
                {!totpValid ? (
                  <span className="ms-spec__error">{d.totpInvalid}</span>
                ) : totp ? (
                  <>
                    <span className="ms-totp__code" aria-live="off">{groupCode(totp.code)}</span>
                    <span className="ms-totp__bar">
                      <Progress
                        value={(totp.secondsRemaining / totp.period) * 100}
                        label={d.totp}
                        valueText={plural(locale, d.totpRefresh, totp.secondsRemaining)}
                        tone={totp.secondsRemaining <= 5 ? 'danger' : 'brand'}
                      />
                      <span>{plural(locale, d.totpRefresh, totp.secondsRemaining)}</span>
                    </span>
                  </>
                ) : (
                  <span className="ms-text-muted">{d.totpLoading}</span>
                )}
              </span>
              <span className="ms-spec__keys">{totp && copyButton('totp', d.totp, totp.code)}</span>
            </li>
          )}
          {fieldEntries.map(([key, value]) => {
            let text = formatValue(value);
            if (item.type === 'card' && key === 'card_type' && (value === 'credit' || value === 'debit')) text = dict.card[value];
            if (item.type === 'card' && key === 'brand' && value === 'other') text = dict.card.otherBrand;
            const label = fieldLabel(dict, key);
            const sensitive = isSensitiveKey(key);
            const isRevealed = Boolean(revealed[key]);
            const isNote = item.type === 'secure_note' && key === 'body';
            return (
              <li key={key} className="ms-spec__row">
                <span className="ms-spec__label">{label}</span>
                <span className={sensitive ? 'ms-spec__value ms-spec__value--secret' : 'ms-spec__value'}>
                  {isNote ? (
                    <span className="block" dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(text) }} />
                  ) : sensitive && !isRevealed ? (
                    <span className="ms-spec__mask">{key === 'card_number' ? `•••• ${cardLast4(item.fields)}` : MASK}</span>
                  ) : sensitive ? (
                    <Revealed text={item.type === 'card' && key === 'card_number'
                      ? formatCardNumber(text, fieldString(item, 'brand') || undefined) : text} />
                  ) : (
                    text
                  )}
                </span>
                <span className="ms-spec__keys">
                  {sensitive && (
                    <IconButton
                      icon={isRevealed ? 'hide' : 'show'}
                      size="sm"
                      label={format(isRevealed ? d.hide : d.show, label)}
                      aria-pressed={isRevealed}
                      onClick={() => toggleReveal(key)}
                    />
                  )}
                  {key === 'url' && openableUrl && (
                    <IconButton icon="open" size="sm" label={d.openWebsite} onClick={() => window.open(openableUrl, '_blank', 'noopener,noreferrer')} />
                  )}
                  {copyButton(`field:${key}`, label, text)}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {(item.type === 'media' || item.type === 'document') && fieldString(item, 'sha256') && (
        <p className="ms-text-sm ms-text-muted mt-3">{d.manifestOnly}</p>
      )}

      {passwordHistory.length > 0 && (
        <section className="ms-spec__section" aria-labelledby={`history-${item.id}`}>
          <h3 id={`history-${item.id}`} className="ms-legend">{d.previousPasswords}</h3>
          <p className="ms-text-sm ms-text-muted mt-0 mb-2">{d.previousPasswordsHint}</p>
          <ul className="ms-spec__rows">
              {passwordHistory.map((entry, i) => {
                const key = `history:${i}`;
                const shown = Boolean(revealed[key]);
                const label = format(d.changedAt, displayDate(locale, entry.changed_at));
                return (
                  <li key={i} className="ms-spec__row">
                    <span className="ms-spec__label">{label}</span>
                    <span className="ms-spec__value ms-spec__value--secret">
                      {shown ? <Revealed text={entry.password} /> : MASK}
                    </span>
                    <span className="ms-spec__keys">
                      <IconButton icon={shown ? 'hide' : 'show'} size="sm" label={format(shown ? d.hide : d.show, label)} aria-pressed={shown} onClick={() => toggleReveal(key)} />
                      {copyButton(key, label, entry.password)}
                    </span>
                  </li>
                );
              })}
          </ul>
        </section>
      )}

      {revisions.length > 0 && (
        <section className="ms-spec__section" aria-labelledby={`revisions-${item.id}`}>
          <h3 id={`revisions-${item.id}`} className="ms-legend">{d.revisions}</h3>
          <p className="ms-text-sm ms-text-muted mt-0 mb-2">{d.revisionsHint}</p>
          <ul className="ms-spec__list">
            {revisions.map((rev, i) => (
              <li key={i}>
                <Card padding="sm">
                  <span className="ms-legend block">{format(d.savedAt, displayDate(locale, rev.saved_at))}</span>
                  <p className="mt-1 mb-2 whitespace-pre-wrap break-words">
                    {rev.body.slice(0, 200)}
                    {rev.body.length > 200 ? '…' : ''}
                  </p>
                  {onRestoreRevision && (
                    <Button size="sm" icon="restore" onClick={() => onRestoreRevision({ ...item, fields: { ...item.fields, body: rev.body } })}>
                      {d.restoreVersion}
                    </Button>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}

      {children.length > 0 && (
        <section className="ms-spec__section" aria-labelledby={`children-${item.id}`}>
          <h3 id={`children-${item.id}`} className="ms-legend">{d.inside}</h3>
          <ul className="ms-spec__list">
            {children.map((child) => (
              <li key={child.id} className="flex items-center gap-2">
                <Icon name="forward" size="sm" />
                {relatedButton(child)}
                <span className="ms-text-sm ms-text-muted">{(dict.itemTypes as Record<string, string>)[child.type] ?? child.type}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="ms-spec__section" aria-labelledby={`relations-${item.id}`}>
        <h3 id={`relations-${item.id}`} className="ms-legend">{d.relations}</h3>
        {item.relations.length === 0 ? (
          <p className="ms-text-sm ms-text-muted m-0">{d.noRelations}</p>
        ) : (
          <ul className="ms-spec__list">
            {item.relations.map((rel) => {
              const target = allItems.find((candidate) => candidate.id === rel.target_id);
              return (
                <li key={rel.target_id} className="flex items-center gap-2">
                  <Icon name="link" size="sm" />
                  {target ? relatedButton(target) : <span className="ms-mono">{rel.target_id} ({d.notFound})</span>}
                  {target && <span className="ms-text-sm ms-text-muted">{(dict.itemTypes as Record<string, string>)[target.type] ?? target.type}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="ms-spec__section" aria-labelledby={`attachments-${item.id}`}>
        <h3 id={`attachments-${item.id}`} className="ms-legend">{d.attachments}</h3>
        {item.attachments.length === 0 ? (
          <p className="ms-text-sm ms-text-muted m-0">{d.noAttachments}</p>
        ) : (
          <ul className="ms-spec__list">
            {item.attachments.map((attachment) => (
              <li key={attachment} className="flex items-center gap-2">
                <Icon name="attachment" size="sm" />
                <code className="ms-mono">{attachment}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      {item.tags.length > 0 && (
        <section className="ms-spec__section" aria-labelledby={`tags-${item.id}`}>
          <h3 id={`tags-${item.id}`} className="ms-legend">{d.tags}</h3>
          <div className="ms-chips">
            {item.tags.map((tag) => (
              <span key={tag} className="ms-chip">#{tag}</span>
            ))}
          </div>
        </section>
      )}

      <p className="ms-spec__stamp">
        {format(d.updated, displayDate(locale, item.updated_at))}
        <br />
        {format(d.created, displayDate(locale, item.created_at))}
      </p>
    </article>
  );
}
