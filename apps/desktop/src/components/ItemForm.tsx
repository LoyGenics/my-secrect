import { useEffect, useRef, useState } from 'react';
import type { ItemType, VaultItem } from '../../../../packages/core/src/types';
import { CARD_TYPES, cardBrands, cardInputError, cardIssuer, cardNumberDigits, detectCardBrand, formatCardNumber, prepareCardFields } from '../../../../packages/core/src/card';
import { loginServiceNames } from '../../../../packages/core/src/login-services';
import PasswordGenerator from './PasswordGenerator';
import LoginServiceField from './LoginServiceField';
import { buildRelations } from './itemFormRelations';
import StrengthMeter from './StrengthMeter';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Field,
  IconButton,
  Input,
  Led,
  SecureField,
  Select,
  Textarea,
  copyWithClear,
  useClipboardStatus,
} from '../theme';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { format, type Dictionary } from '../../../../packages/i18n/src/index';
import { isValidBase32Secret } from '../utils/totp';
import { renderMarkdownToHtml } from '../utils/markdown';
import { readLocalCardCode } from '../vault';
import TypeStamp from './TypeStamp';
import {
  getPasswordHistory,
  appendPasswordHistory,
  getNoteRevisions,
  appendNoteRevision,
} from '../utils/itemMeta';

interface ItemFormProps {
  initial?: VaultItem | null;
  defaultType?: ItemType;
  onSave: (item: VaultItem, localCardCode?: string) => Promise<void> | void;
  onCancel: () => void;
  allItems?: VaultItem[];
  /**
   * Autosave hook for secure notes (existing items only): called with the
   * current item, debounced, WITHOUT closing the form. The caller must
   * upsert without touching form state (see App.tsx handleAutosaveItem).
   * When absent, notes save only via the Save button.
   */
  onAutosave?: (item: VaultItem) => Promise<void> | void;
}

type FieldInputType = 'text' | 'password' | 'textarea' | 'date' | 'url';

interface FieldDef {
  key: string;
  type?: FieldInputType;
  /** Key into dict.placeholders. The label is dict.fields[key]. */
  placeholder?: keyof Dictionary['placeholders'];
  autoComplete?: string;
}

const ALL_TYPES: ItemType[] = [
  'login', 'passkey', 'bank_account', 'card', 'identity', 'ssh_key',
  'api_key', 'secure_note', 'document', 'media', 'collection', 'custom',
];

const FIELD_DEFS: Record<ItemType, FieldDef[]> = {
  login: [
    { key: 'username', autoComplete: 'username' },
    { key: 'password', type: 'password', autoComplete: 'new-password' },
    { key: 'url', type: 'url', placeholder: 'url', autoComplete: 'url' },
    { key: 'totp_secret', placeholder: 'totp', autoComplete: 'off' },
    { key: 'notes', type: 'textarea', autoComplete: 'off' },
  ],
  passkey: [
    { key: 'credential_id', autoComplete: 'off' },
    { key: 'rp_id', placeholder: 'rpId', autoComplete: 'off' },
    { key: 'public_key', type: 'textarea', autoComplete: 'off' },
    { key: 'notes', type: 'textarea', autoComplete: 'off' },
  ],
  bank_account: [
    { key: 'bank_name', autoComplete: 'off' },
    { key: 'account_number', autoComplete: 'off' },
    { key: 'currency', placeholder: 'currency', autoComplete: 'off' },
    { key: 'holder_name', autoComplete: 'off' },
    { key: 'branch', autoComplete: 'off' },
    { key: 'notes', type: 'textarea', autoComplete: 'off' },
  ],
  card: [
    { key: 'card_number' },
    { key: 'brand' },
    { key: 'card_type' },
    { key: 'cardholder' },
    { key: 'expiry', placeholder: 'expiry' },
    { key: 'cvv' },
    { key: 'credit_limit' },
    { key: 'statement_day' },
    { key: 'notes', type: 'textarea', autoComplete: 'off' },
  ],
  identity: [
    { key: 'full_name', autoComplete: 'name' },
    { key: 'document_type', placeholder: 'documentType', autoComplete: 'off' },
    { key: 'document_number', autoComplete: 'off' },
    { key: 'issued_date', type: 'date', autoComplete: 'off' },
    { key: 'expiry_date', type: 'date', autoComplete: 'off' },
    { key: 'notes', type: 'textarea', autoComplete: 'off' },
  ],
  ssh_key: [
    { key: 'public_key', type: 'textarea', autoComplete: 'off' },
    { key: 'private_key', type: 'textarea', autoComplete: 'off' },
    { key: 'comment', autoComplete: 'off' },
    { key: 'notes', type: 'textarea', autoComplete: 'off' },
  ],
  api_key: [
    { key: 'service', autoComplete: 'off' },
    { key: 'key', type: 'password', autoComplete: 'off' },
    { key: 'scopes', placeholder: 'scopes', autoComplete: 'off' },
    { key: 'expires_at', type: 'date', autoComplete: 'off' },
    { key: 'notes', type: 'textarea', autoComplete: 'off' },
  ],
  secure_note: [
    { key: 'body', type: 'textarea', autoComplete: 'off' },
    { key: 'checklist', type: 'textarea', autoComplete: 'off' },
    { key: 'notes', type: 'textarea', autoComplete: 'off' },
  ],
  document: [
    { key: 'file_name', autoComplete: 'off' },
    { key: 'mime_type', placeholder: 'mimeDocument', autoComplete: 'off' },
    { key: 'size', autoComplete: 'off' },
    { key: 'blob_id', placeholder: 'fromFile', autoComplete: 'off' },
    { key: 'sha256', placeholder: 'fromFile', autoComplete: 'off' },
    { key: 'notes', type: 'textarea', autoComplete: 'off' },
  ],
  media: [
    { key: 'file_name', autoComplete: 'off' },
    { key: 'mime_type', placeholder: 'mimeMedia', autoComplete: 'off' },
    { key: 'size', autoComplete: 'off' },
    { key: 'width', autoComplete: 'off' },
    { key: 'height', autoComplete: 'off' },
    { key: 'duration_s', autoComplete: 'off' },
    { key: 'blob_id', placeholder: 'fromFile', autoComplete: 'off' },
    { key: 'sha256', placeholder: 'fromFile', autoComplete: 'off' },
    { key: 'notes', type: 'textarea', autoComplete: 'off' },
  ],
  collection: [
    { key: 'description', type: 'textarea', autoComplete: 'off' },
    { key: 'url', type: 'url', placeholder: 'url', autoComplete: 'url' },
    { key: 'notes', type: 'textarea', autoComplete: 'off' },
  ],
  // Custom: only Notes is fixed; every other field is a user-named custom field below.
  custom: [
    { key: 'notes', type: 'textarea', autoComplete: 'off' },
  ],
};

function newItemId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return 'item_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function initialFields(item: VaultItem | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!item) return out;
  for (const [key, value] of Object.entries(item.fields ?? {})) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = String(value);
    }
  }
  if (item.type === 'card' && out.brand === detectCardBrand(out.card_number ?? '')) delete out.brand;
  return out;
}

interface CustomPair { name: string; value: string; }

function initialCustomPairs(item: VaultItem | null | undefined): CustomPair[] {
  if (!item || item.type !== 'custom') return [];
  const fixed = new Set(FIELD_DEFS.custom.map((d) => d.key));
  return Object.entries(item.fields ?? {})
    .filter(([key, v]) => !fixed.has(key) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
    .map(([name, v]) => ({ name, value: String(v) }));
}

export default function ItemForm({ initial = null, defaultType = 'login', onSave, onCancel, allItems = [], onAutosave }: ItemFormProps) {
  const { dict } = useTranslation();
  const { copiedKey } = useClipboardStatus();
  const [type, setType] = useState<ItemType>(initial?.type ?? defaultType);
  const [title, setTitle] = useState(() => initial?.type === 'card' ? cardIssuer(initial.title, initial.fields.bank) : initial?.title ?? '');
  const [tagsText, setTagsText] = useState((initial?.tags ?? []).join(', '));
  const [favorite, setFavorite] = useState(Boolean(initial?.favorite));
  const [fields, setFields] = useState<Record<string, string>>(() => initialFields(initial));
  const [customPairs, setCustomPairs] = useState<CustomPair[]>(() => initialCustomPairs(initial));
  const [relationIds, setRelationIds] = useState<string[]>(() =>
    (initial?.relations ?? []).map((r) => r.target_id),
  );
  const [error, setError] = useState('');
  const [loadedCode, setLoadedCode] = useState('');
  const [localCardCode, setLocalCardCode] = useState<string>();
  const [codeReadFailed, setCodeReadFailed] = useState(false);
  const cardId = initial?.type === 'card' ? initial.id : undefined;
  useEffect(() => {
    if (!cardId) return;
    let active = true;
    void readLocalCardCode(cardId).then(
      (value) => { if (active) setLoadedCode(value); },
      () => { if (active) setCodeReadFailed(true); },
    );
    return () => { active = false; };
  }, [cardId]);
  const [showPassword, setShowPassword] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  // Stable id for this form instance: a new item gets its id at mount so
  // autosave and explicit Save write the same item.
  const [itemId] = useState(() => initial?.id ?? newItemId());
  // Nested collections: a collection may live inside another collection.
  const [parentId, setParentId] = useState<string>(
    () => (typeof initial?.fields?.parent_id === 'string' ? (initial.fields.parent_id as string) : ''),
  );
  // Secure-note Markdown preview.
  const [showPreview, setShowPreview] = useState(false);
  // Autosave state (secure notes, existing items only).
  const [autosaveState, setAutosaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [autosaveAt, setAutosaveAt] = useState('');
  // Seeded with the as-opened snapshot so merely opening a note does not autosave (and bump its revision) 1.5s later.
  const lastAutosavedRef = useRef(`${title}\n${fields.body ?? ''}`);

  const setField = (key: string, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };
  const fieldValue = (key: string): string => fields[key] ?? '';
  const cardBrand = type === 'card' ? fieldValue('brand') || detectCardBrand(fieldValue('card_number')) : undefined;

  function changeCardNumber(input: HTMLInputElement) {
    const digits = cardNumberDigits(input.value);
    const brand = fieldValue('brand') || detectCardBrand(digits);
    const formatted = formatCardNumber(digits, brand);
    if (input.value !== formatted) {
      const beforeCaret = input.value.slice(0, input.selectionStart ?? input.value.length);
      const caret = formatCardNumber(beforeCaret, brand).length;
      input.value = formatted;
      input.setSelectionRange(caret, caret);
    }
    setField('card_number', digits);
  }

  const totpSecret = fieldValue('totp_secret');
  const totpInvalid = type === 'login' && totpSecret.trim() !== '' && !isValidBase32Secret(totpSecret);

  const handleTypeChange = (next: ItemType) => {
    setType(next);
    setFields({});
    setCustomPairs([]);
    setParentId('');
    setShowPreview(false);
    setShowPassword(false);
    setShowGenerator(false);
    setShowApiKey(false);
    setError('');
  };

  /** File picker for media/document: manifest only — hash the file, never store its bytes. */
  const handleFile = async (file: File) => {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    const blobBytes = new Uint8Array(8);
    crypto.getRandomValues(blobBytes);
    const blobId = 'blob_' + Array.from(blobBytes, (b) => b.toString(16).padStart(2, '0')).join('');
    setFields((prev) => ({
      ...prev,
      file_name: file.name,
      mime_type: file.type || 'application/octet-stream',
      size: String(file.size),
      sha256,
      blob_id: blobId,
    }));
  };

  /**
   * Build the item from current form state. `appendHistory` is true only
   * for an explicit Save: when a login password or a note body changed
   * vs. the item as opened, the OLD value is prepended to the encrypted
   * password_history / revisions. Autosave passes false so a long typing
   * session does not create a revision per pause — the revision is
   * recorded once, at explicit Save, against the body as opened.
   * Non-string field values (archived flag, history, revisions) are
   * carried through untouched — the form only edits string fields, and
   * dropping them here would silently erase history on every edit.
   */
  const buildItem = (appendHistory: boolean): VaultItem => {
    const now = new Date().toISOString();
    const cleanedFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      const trimmed = value.trim();
      if (trimmed !== '') cleanedFields[key] = trimmed;
    }
    if (type === 'custom') {
      for (const pair of customPairs) {
        const name = pair.name.trim();
        const value = pair.value.trim();
        if (name && value) cleanedFields[name] = value;
      }
    }
    if (initial) {
      // Carry encrypted metadata the form does not edit.
      if (initial.fields?.archived === true) cleanedFields.archived = true;
      const prevHistory = getPasswordHistory(initial);
      if (prevHistory.length > 0) cleanedFields.password_history = prevHistory;
      const prevRevisions = getNoteRevisions(initial);
      if (prevRevisions.length > 0) cleanedFields.revisions = prevRevisions;
      if (appendHistory && type === 'login') {
        const oldPw = typeof initial.fields?.password === 'string' ? (initial.fields.password as string) : '';
        const newPw = typeof cleanedFields.password === 'string' ? (cleanedFields.password as string) : '';
        if (oldPw && newPw && oldPw !== newPw) {
          cleanedFields.password_history = appendPasswordHistory(prevHistory, oldPw, now);
        }
      }
      if (appendHistory && type === 'secure_note') {
        const oldBody = typeof initial.fields?.body === 'string' ? (initial.fields.body as string) : '';
        const newBody = typeof cleanedFields.body === 'string' ? (cleanedFields.body as string) : '';
        if (oldBody && newBody && oldBody !== newBody) {
          cleanedFields.revisions = appendNoteRevision(prevRevisions, oldBody, now);
        }
      }
    }
    // The parent selector owns parent_id: without the delete below,
    // clearing the parent would leave the stale value from `fields`.
    if (type === 'collection') {
      if (parentId) cleanedFields.parent_id = parentId;
      else delete cleanedFields.parent_id;
    }
    if (type === 'card') prepareCardFields(cleanedFields);
    const item: VaultItem = {
      id: itemId,
      type,
      schema_version: 1,
      title: title.trim(),
      fields: cleanedFields,
      tags: tagsText.split(',').map((t) => t.trim()).filter(Boolean),
      relations: buildRelations(initial?.relations, relationIds),
      attachments: initial?.attachments ?? [],
      created_at: initial?.created_at ?? now,
      updated_at: now,
    };
    item.favorite = favorite;
    if (initial?.deleted_at) item.deleted_at = initial.deleted_at;
    return item;
  };

  const buildRef = useRef(buildItem);
  buildRef.current = buildItem;

  // Autosave for secure notes (existing items only): 1.5s after the user
  // stops typing, upsert the note WITHOUT closing the form. The write
  // goes through onAutosave, which encrypts into the vault — a draft is
  // never left in plaintext localStorage.
  const bodyValue = fields.body ?? '';
  useEffect(() => {
    if (!initial || type !== 'secure_note' || !onAutosave) return;
    if (title.trim() === '') return;
    const snapshot = `${title}\n${bodyValue}`;
    if (snapshot === lastAutosavedRef.current) return;
    setAutosaveState('idle');
    const timer = window.setTimeout(() => {
      setAutosaveState('saving');
      void Promise.resolve(onAutosave(buildRef.current(false)))
        .then(() => {
          lastAutosavedRef.current = snapshot;
          setAutosaveAt(new Date().toLocaleTimeString());
          setAutosaveState('saved');
        })
        .catch(() => setAutosaveState('error'));
    }, 1500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyValue, title, type, initial, onAutosave]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (title.trim() === '') {
      setError(titleRequired);
      return;
    }
    if (totpInvalid) {
      setError(dict.itemForm.totpInvalid);
      return;
    }
    if (type === 'card') {
      const issue = cardInputError(fields, localCardCode ?? '');
      if (issue) {
        setError(dict.card[issue]);
        return;
      }
    }
    if (type === 'custom') {
      const names = customPairs.map((p) => p.name.trim()).filter(Boolean);
      if (new Set(names).size !== names.length) {
        setError(dict.itemForm.customUnique);
        return;
      }
    }
    setSaving(true);
    try {
      await onSave(buildItem(true), type === 'card' ? localCardCode : undefined);
    } catch {
      setError(f.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  const relationCandidates = allItems.filter((candidate) => candidate.id !== initial?.id);
  const f = dict.itemForm;
  const titleRequired = type === 'login' ? f.loginServiceRequired : type === 'card' ? dict.card.issuerRequired : f.titleRequired;
  const label = (key: string) => (dict.fields as Record<string, string>)[key] ?? key;
  const placeholder = (def: FieldDef) => (def.placeholder ? dict.placeholders[def.placeholder] : undefined);

  const renderField = (def: FieldDef) => {
    const value = fieldValue(def.key);
    const inputId = `field-${def.key}`;
    const inputName = `field-${def.key}`;
    if (type === 'card' && (def.key === 'brand' || def.key === 'card_type')) {
      const brand = def.key === 'brand';
      const selected = brand ? cardBrand ?? '' : value;
      return (
        <Field key={def.key} id={inputId} label={label(def.key)}>
          <Select name={inputName} value={selected} onChange={(e) => setField(def.key, e.target.value)}>
            <option value="">{brand ? dict.card.chooseBrand : dict.card.chooseType}</option>
            {brand ? cardBrands(selected).map((network) => (
              <option key={network} value={network}>{network === 'other' ? dict.card.otherBrand : network}</option>
            )) : CARD_TYPES.map((kind) => <option key={kind} value={kind}>{dict.card[kind]}</option>)}
          </Select>
        </Field>
      );
    }
    if (type === 'card' && (def.key === 'card_number' || def.key === 'cvv')) {
      const cvv = def.key === 'cvv';
      const fieldLabel = label(def.key);
      const hint = cvv ? dict.card.cvvHint : !value && fields.last4 ? format(dict.card.existingDigits, fields.last4) : undefined;
      return (
        <Field key={def.key} id={inputId} label={fieldLabel} hint={hint} error={cvv && codeReadFailed ? dict.card.codeReadFailed : undefined}>
          <SecureField
            name={inputName}
            value={cvv ? localCardCode ?? loadedCode : formatCardNumber(value, cardBrand)}
            onChange={(e) => cvv ? setLocalCardCode(e.target.value) : changeCardNumber(e.currentTarget)}
            inputMode="numeric"
            autoComplete="off"
            maxLength={cvv ? 4 : undefined}
            showLabel={format(dict.itemDetail.show, fieldLabel)}
            hideLabel={format(dict.itemDetail.hide, fieldLabel)}
          />
        </Field>
      );
    }
    // Login password: show/hide + inline generator + strength meter.
    if (type === 'login' && def.key === 'password') {
      return (
        <div key={def.key} className="ms-field">
          <label className="ms-label" htmlFor={inputId}>{label(def.key)}</label>
          <div className="ms-field-row">
            <Input
              id={inputId}
              name={inputName}
              type={showPassword ? 'text' : 'password'}
              value={value}
              autoComplete="new-password"
              aria-label={label('password')}
              mono
              onChange={(e) => setField(def.key, e.target.value)}
            />
            <IconButton
              icon={showPassword ? 'hide' : 'show'}
              variant="secondary"
              label={showPassword ? f.hide : f.show}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((v) => !v)}
            />
            <Button variant="secondary" icon="generate" aria-expanded={showGenerator} onClick={() => setShowGenerator((v) => !v)}>
              {f.generate}
            </Button>
          </div>
          {value && (
            <div className="mt-2">
              <StrengthMeter password={value} />
            </div>
          )}
          {showGenerator && (
            <Card className="mt-3">
              <PasswordGenerator
                onUse={(pw) => {
                  setField('password', pw);
                  setShowGenerator(false);
                }}
              />
            </Card>
          )}
        </div>
      );
    }
    // API key: masked field with show/hide + copy.
    if (type === 'api_key' && def.key === 'key') {
      return (
        <div key={def.key} className="ms-field">
          <label className="ms-label" htmlFor={inputId}>{label(def.key)}</label>
          <div className="ms-field-row">
            <Input
              id={inputId}
              name={inputName}
              type={showApiKey ? 'text' : 'password'}
              value={value}
              autoComplete="off"
              aria-label={label('key')}
              mono
              onChange={(e) => setField(def.key, e.target.value)}
            />
            <IconButton
              icon={showApiKey ? 'hide' : 'show'}
              variant="secondary"
              label={showApiKey ? f.hide : f.show}
              aria-pressed={showApiKey}
              onClick={() => setShowApiKey((v) => !v)}
            />
            <IconButton
              icon={copiedKey === `form:${itemId}:key` ? 'check' : 'copy'}
              variant="secondary"
              label={copiedKey === `form:${itemId}:key` ? f.copied : f.copy}
              disabled={!value}
              onClick={() => void copyWithClear(`form:${itemId}:key`, value)}
            />
          </div>
        </div>
      );
    }
    if (def.type === 'textarea') {
      return (
        <div key={def.key} className="ms-field">
          <label className="ms-label" htmlFor={inputId}>{label(def.key)}</label>
          <Textarea
            id={inputId}
            name={inputName}
            value={value}
            placeholder={placeholder(def)}
            autoComplete={def.autoComplete ?? 'off'}
            aria-label={label(def.key)}
            onChange={(e) => setField(def.key, e.target.value)}
            rows={def.key === 'private_key' || def.key === 'public_key' ? 5 : 3}
            mono={def.key === 'private_key' || def.key === 'public_key'}
          />
          {type === 'ssh_key' && def.key === 'private_key' && <p className="ms-field__hint">{f.privateKeyNote}</p>}
          {type === 'secure_note' && def.key === 'body' && (
            <div className="mt-2 grid gap-2">
              <div>
                <Button size="sm" icon={showPreview ? 'hide' : 'show'} aria-expanded={showPreview} onClick={() => setShowPreview((v) => !v)}>
                  {showPreview ? f.hidePreview : f.preview}
                </Button>
              </div>
              {showPreview && <Card dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(value) }} />}
              {initial && onAutosave && (
                <p className="ms-field__hint flex items-center gap-2" role="status">
                  <Led tone={autosaveState === 'saved' ? 'ok' : autosaveState === 'error' ? 'danger' : autosaveState === 'saving' ? 'attention' : 'off'} />
                  {autosaveState === 'saving'
                    ? f.autosaving
                    : autosaveState === 'saved'
                      ? format(f.autosaved, autosaveAt)
                      : autosaveState === 'error'
                        ? f.autosaveFailed
                        : f.autosaveIdle}
                </p>
              )}
            </div>
          )}
        </div>
      );
    }
    return (
      <Field
        key={def.key}
        id={inputId}
        label={label(def.key)}
        error={type === 'login' && def.key === 'totp_secret' && totpInvalid ? f.totpInvalid : undefined}
      >
        <Input
          name={inputName}
          type={def.type ?? 'text'}
          value={value}
          placeholder={def.key === 'credit_limit' ? dict.card.limitPlaceholder : def.key === 'statement_day' ? dict.card.dayPlaceholder : placeholder(def)}
          inputMode={def.key === 'statement_day' ? 'numeric' : undefined}
          autoComplete={def.autoComplete ?? 'off'}
          aria-label={label(def.key)}
          mono={def.key === 'totp_secret' || def.key === 'sha256' || def.key === 'blob_id'}
          onChange={(e) => setField(def.key, e.target.value)}
        />
      </Field>
    );
  };

  return (
    <form onSubmit={handleSave} className="ms-spec" aria-labelledby="item-form-title" noValidate>
      <header className="ms-spec__head mb-6">
        <TypeStamp type={type} size="lg" />
        <div className="ms-spec__title">
          <h2 id="item-form-title" className="ms-spec__name">{initial ? f.editTitle : f.newTitle}</h2>
        </div>
      </header>
      {error && (
        <Alert tone="danger" announce className="mb-4">
          {error}
        </Alert>
      )}
      <Card as="section" padding="none" className="ms-card--flat" aria-labelledby="item-form-title">
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field id="item-type" label={f.type}>
            <Select name="item-type" value={type} onChange={(e) => handleTypeChange(e.target.value as ItemType)} aria-label={f.typeAria}>
              {ALL_TYPES.map((t) => (
                <option key={t} value={t}>{dict.itemTypes[t]}</option>
              ))}
            </Select>
          </Field>
          {type === 'login' ? (
            <LoginServiceField value={title} onChange={setTitle} names={loginServiceNames(allItems, initial?.type === 'login' ? initial.title : '')} />
          ) : (
            <Field id="item-title" label={type === 'card' ? dict.card.issuer : f.title}>
              <Input
                name="item-title"
                type="text"
                value={title}
                placeholder={type === 'card' ? dict.card.issuerPlaceholder : dict.placeholders.title}
                onChange={(e) => setTitle(e.target.value)}
                autoComplete="off"
              />
            </Field>
          )}
        </div>
        <Field id="item-tags" label={f.tags}>
          <Input
            name="item-tags"
            type="text"
            value={tagsText}
            placeholder={dict.placeholders.tags}
            onChange={(e) => setTagsText(e.target.value)}
            autoComplete="off"
            aria-label={f.tagsAria}
          />
        </Field>
        <Checkbox
          id="item-favorite"
          name="item-favorite"
          label={f.favorite}
          checked={favorite}
          onChange={(e) => setFavorite(e.target.checked)}
          className="mb-4"
        />

        <hr className="ms-rule" />

        {FIELD_DEFS[type].filter(({ key }) => type !== 'card' || fields.card_type === 'credit' || (key !== 'credit_limit' && key !== 'statement_day')).map(renderField)}

        {type === 'collection' && (
          <Field id="item-parent-collection" label={f.parent} hint={f.parentHint}>
            <Select name="item-parent-collection" value={parentId} onChange={(e) => setParentId(e.target.value)} aria-label={f.parentAria}>
              <option value="">{f.parentNone}</option>
              {allItems
                .filter((c) => c.type === 'collection' && c.id !== itemId)
                .map((c) => (
                  <option key={c.id} value={c.id}>{c.title}</option>
                ))}
            </Select>
          </Field>
        )}

        {type === 'custom' && (
          <fieldset className="m-0 mb-4 border-0 p-0">
            <legend className="ms-label">{f.customFields}</legend>
            {customPairs.length === 0 && <p className="ms-field__hint mt-0">{f.customEmpty}</p>}
            {customPairs.map((pair, i) => (
              <div key={i} className="mb-2 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-end gap-2">
                <Field id={`custom-field-name-${i}`} label={f.customName} flush>
                  <Input
                    name={`custom-field-name-${i}`}
                    type="text"
                    value={pair.name}
                    placeholder={dict.placeholders.customName}
                    autoComplete="off"
                    aria-label={format(f.customNameAria, i + 1)}
                    onChange={(e) => setCustomPairs((prev) => prev.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)))}
                  />
                </Field>
                <Field id={`custom-field-value-${i}`} label={f.customValue} flush>
                  <Input
                    name={`custom-field-value-${i}`}
                    type="text"
                    value={pair.value}
                    autoComplete="off"
                    aria-label={format(f.customValueAria, i + 1)}
                    onChange={(e) => setCustomPairs((prev) => prev.map((p, j) => (j === i ? { ...p, value: e.target.value } : p)))}
                  />
                </Field>
                <IconButton
                  icon="close"
                  variant="secondary"
                  label={format(f.removeCustom, i + 1)}
                  onClick={() => setCustomPairs((prev) => prev.filter((_, j) => j !== i))}
                />
              </div>
            ))}
            <Button size="sm" icon="add" onClick={() => setCustomPairs((prev) => [...prev, { name: '', value: '' }])}>
              {f.addCustom}
            </Button>
          </fieldset>
        )}

        {(type === 'media' || type === 'document') && (
          <Card padding="sm" className="mb-4">
            <label className="ms-label" htmlFor={`${type}-file`}>{f.attachFile}</label>
            <input
              id={`${type}-file`}
              name={`${type}-file`}
              type="file"
              className="ms-text-sm block w-full"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
              aria-label={format(f.attachAria, dict.itemTypes[type])}
            />
            <p className="ms-field__hint">{f.attachNote}</p>
            {fieldValue('sha256') && (
              <p className="ms-text-sm mb-0 mt-2">
                <span className="ms-legend">SHA-256</span> <code className="ms-mono break-all">{fieldValue('sha256')}</code>
              </p>
            )}
          </Card>
        )}

        {relationCandidates.length > 0 && (
          <fieldset className="m-0 border-0 p-0">
            <legend className="ms-label">{f.relations}</legend>
            <div className="grid max-h-56 gap-1.5 overflow-y-auto pr-1">
              {relationCandidates.map((candidate) => (
                <Checkbox
                  key={candidate.id}
                  id={`relation-${candidate.id}`}
                  name={`relation-${candidate.id}`}
                  checked={relationIds.includes(candidate.id)}
                  onChange={(e) => {
                    setRelationIds((prev) =>
                      e.target.checked ? [...prev, candidate.id] : prev.filter((id) => id !== candidate.id),
                    );
                  }}
                  aria-label={format(f.relateTo, candidate.title)}
                  label={
                    <span>
                      {candidate.title}{' '}
                      <span className="ms-text-sm ms-text-muted">{dict.itemTypes[candidate.type]}</span>
                    </span>
                  }
                />
              ))}
            </div>
          </fieldset>
        )}
      </Card>

      <div className="ms-form-foot">
        <Button type="submit" variant="primary" icon="check" loading={saving}>
          {saving ? f.saving : f.save}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {f.cancel}
        </Button>
      </div>
    </form>
  );
}
