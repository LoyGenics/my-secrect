import { useState } from 'react';
import type { ItemType, VaultItem } from '../../../packages/core/src/types';
import PasswordGenerator from './PasswordGenerator';
import StrengthMeter from './StrengthMeter';
import { isValidBase32Secret } from '../utils/totp';

interface ItemFormProps {
  initial?: VaultItem | null;
  defaultType?: ItemType;
  onSave: (item: VaultItem) => Promise<void> | void;
  onCancel: () => void;
  allItems?: VaultItem[];
}

type FieldInputType = 'text' | 'password' | 'textarea' | 'date' | 'url';

interface FieldDef {
  key: string;
  label: string;
  type?: FieldInputType;
  placeholder?: string;
  autoComplete?: string;
}

const ALL_TYPES: ItemType[] = [
  'login', 'passkey', 'bank_account', 'card', 'identity', 'ssh_key',
  'api_key', 'secure_note', 'document', 'media', 'collection', 'custom',
];

const TYPE_LABELS: Record<ItemType, string> = {
  login: 'Login',
  passkey: 'Passkey',
  bank_account: 'Bank account',
  card: 'Card',
  identity: 'Identity',
  ssh_key: 'SSH key',
  api_key: 'API key',
  secure_note: 'Secure note',
  document: 'Document',
  media: 'Media',
  collection: 'Collection',
  custom: 'Custom',
};

const FIELD_DEFS: Record<ItemType, FieldDef[]> = {
  login: [
    { key: 'username', label: 'Username', autoComplete: 'username' },
    { key: 'password', label: 'Password', type: 'password', autoComplete: 'new-password' },
    { key: 'url', label: 'URL', type: 'url', placeholder: 'https://…', autoComplete: 'url' },
    { key: 'totp_secret', label: 'TOTP secret (Base32)', placeholder: 'e.g. JBSWY3DPEHPK3PXP', autoComplete: 'off' },
    { key: 'notes', label: 'Notes', type: 'textarea', autoComplete: 'off' },
  ],
  passkey: [
    { key: 'credential_id', label: 'Credential ID', autoComplete: 'off' },
    { key: 'rp_id', label: 'Relying party ID (rp_id)', placeholder: 'e.g. example.com', autoComplete: 'off' },
    { key: 'public_key', label: 'Public key', type: 'textarea', autoComplete: 'off' },
    { key: 'notes', label: 'Notes', type: 'textarea', autoComplete: 'off' },
  ],
  bank_account: [
    { key: 'bank_name', label: 'Bank name', autoComplete: 'off' },
    { key: 'account_number', label: 'Account number', autoComplete: 'off' },
    { key: 'currency', label: 'Currency', placeholder: 'VND', autoComplete: 'off' },
    { key: 'holder_name', label: 'Account holder name', autoComplete: 'off' },
    { key: 'branch', label: 'Branch', autoComplete: 'off' },
    { key: 'notes', label: 'Notes', type: 'textarea', autoComplete: 'off' },
  ],
  // Card: metadata only. CVV / PIN are never stored — there is no field for them.
  card: [
    { key: 'cardholder', label: 'Cardholder name', autoComplete: 'cc-name' },
    { key: 'last4', label: 'Last 4 digits', placeholder: '1234', autoComplete: 'cc-number' },
    { key: 'brand', label: 'Brand', placeholder: 'Visa / Mastercard…', autoComplete: 'off' },
    { key: 'expiry', label: 'Expiry', placeholder: 'MM/YY', autoComplete: 'cc-exp' },
    { key: 'bank', label: 'Bank', autoComplete: 'off' },
    { key: 'notes', label: 'Notes', type: 'textarea', autoComplete: 'off' },
  ],
  identity: [
    { key: 'full_name', label: 'Full name', autoComplete: 'name' },
    { key: 'document_type', label: 'Document type', placeholder: 'Passport / ID card / Driving licence…', autoComplete: 'off' },
    { key: 'document_number', label: 'Document number', autoComplete: 'off' },
    { key: 'issued_date', label: 'Issued date', type: 'date', autoComplete: 'off' },
    { key: 'expiry_date', label: 'Expiry date', type: 'date', autoComplete: 'off' },
    { key: 'notes', label: 'Notes', type: 'textarea', autoComplete: 'off' },
  ],
  ssh_key: [
    { key: 'public_key', label: 'Public key', type: 'textarea', autoComplete: 'off' },
    { key: 'private_key', label: 'Private key', type: 'textarea', autoComplete: 'off' },
    { key: 'comment', label: 'Comment', autoComplete: 'off' },
    { key: 'notes', label: 'Notes', type: 'textarea', autoComplete: 'off' },
  ],
  api_key: [
    { key: 'service', label: 'Service', autoComplete: 'off' },
    { key: 'key', label: 'API key', type: 'password', autoComplete: 'off' },
    { key: 'scopes', label: 'Scopes', placeholder: 'comma-separated', autoComplete: 'off' },
    { key: 'expires_at', label: 'Expires at', type: 'date', autoComplete: 'off' },
    { key: 'notes', label: 'Notes', type: 'textarea', autoComplete: 'off' },
  ],
  secure_note: [
    { key: 'body', label: 'Note', type: 'textarea', autoComplete: 'off' },
    { key: 'checklist', label: 'Checklist (one item per line)', type: 'textarea', autoComplete: 'off' },
    { key: 'notes', label: 'Notes', type: 'textarea', autoComplete: 'off' },
  ],
  document: [
    { key: 'file_name', label: 'File name', autoComplete: 'off' },
    { key: 'mime_type', label: 'MIME type', placeholder: 'application/pdf', autoComplete: 'off' },
    { key: 'size', label: 'Size (bytes)', autoComplete: 'off' },
    { key: 'blob_id', label: 'Blob ID', placeholder: 'Set by choosing a file below', autoComplete: 'off' },
    { key: 'sha256', label: 'SHA-256', placeholder: 'Set by choosing a file below', autoComplete: 'off' },
    { key: 'notes', label: 'Notes', type: 'textarea', autoComplete: 'off' },
  ],
  media: [
    { key: 'file_name', label: 'File name', autoComplete: 'off' },
    { key: 'mime_type', label: 'MIME type', placeholder: 'image/jpeg', autoComplete: 'off' },
    { key: 'size', label: 'Size (bytes)', autoComplete: 'off' },
    { key: 'width', label: 'Width (px)', autoComplete: 'off' },
    { key: 'height', label: 'Height (px)', autoComplete: 'off' },
    { key: 'duration_s', label: 'Duration (seconds, video only)', autoComplete: 'off' },
    { key: 'blob_id', label: 'Blob ID', placeholder: 'Set by choosing a file below', autoComplete: 'off' },
    { key: 'sha256', label: 'SHA-256', placeholder: 'Set by choosing a file below', autoComplete: 'off' },
    { key: 'notes', label: 'Notes', type: 'textarea', autoComplete: 'off' },
  ],
  collection: [
    { key: 'description', label: 'Description', type: 'textarea', autoComplete: 'off' },
    { key: 'url', label: 'URL', type: 'url', placeholder: 'https://…', autoComplete: 'url' },
    { key: 'notes', label: 'Notes', type: 'textarea', autoComplete: 'off' },
  ],
  // Custom: only Notes is fixed; every other field is a user-named custom field below.
  custom: [
    { key: 'notes', label: 'Notes', type: 'textarea', autoComplete: 'off' },
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

export default function ItemForm({ initial = null, defaultType = 'login', onSave, onCancel, allItems = [] }: ItemFormProps) {
  const [type, setType] = useState<ItemType>(initial?.type ?? defaultType);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [tagsText, setTagsText] = useState((initial?.tags ?? []).join(', '));
  const [favorite, setFavorite] = useState(Boolean(initial?.favorite));
  const [fields, setFields] = useState<Record<string, string>>(() => initialFields(initial));
  const [customPairs, setCustomPairs] = useState<CustomPair[]>(() => initialCustomPairs(initial));
  const [relationIds, setRelationIds] = useState<string[]>(() =>
    (initial?.relations ?? []).map((r) => r.target_id),
  );
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeyCopied, setApiKeyCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  const setField = (key: string, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };
  const fieldValue = (key: string): string => fields[key] ?? '';

  const totpSecret = fieldValue('totp_secret');
  const totpInvalid = type === 'login' && totpSecret.trim() !== '' && !isValidBase32Secret(totpSecret);

  const handleTypeChange = (next: ItemType) => {
    setType(next);
    setFields({});
    setCustomPairs([]);
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

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (title.trim() === '') {
      setError('Title is required.');
      return;
    }
    if (totpInvalid) {
      setError('Invalid TOTP secret.');
      return;
    }
    if (type === 'custom') {
      const names = customPairs.map((p) => p.name.trim()).filter(Boolean);
      if (new Set(names).size !== names.length) {
        setError('Custom field names must be unique.');
        return;
      }
    }
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
    const item: VaultItem = {
      id: initial?.id ?? newItemId(),
      type,
      schema_version: 1,
      title: title.trim(),
      fields: cleanedFields,
      tags: tagsText.split(',').map((t) => t.trim()).filter(Boolean),
      relations: relationIds.map((target_id) => ({ type: 'related_to', target_id })),
      attachments: initial?.attachments ?? [],
      created_at: initial?.created_at ?? now,
      updated_at: now,
    };
    item.favorite = favorite;
    if (initial?.deleted_at) item.deleted_at = initial.deleted_at;
    setSaving(true);
    try {
      await onSave(item);
    } finally {
      setSaving(false);
    }
  };

  const relationCandidates = allItems.filter((candidate) => candidate.id !== initial?.id);

  const renderField = (def: FieldDef) => {
    const value = fieldValue(def.key);
    const inputId = `field-${def.key}`;
    const inputName = `field-${def.key}`;
    // Login password: show/hide + inline generator + strength meter.
    if (type === 'login' && def.key === 'password') {
      return (
        <div key={def.key} style={{ marginTop: 8 }}>
          <label className="label" htmlFor={inputId}>{def.label}</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              id={inputId}
              name={inputName}
              type={showPassword ? 'text' : 'password'}
              value={value}
              autoComplete="new-password"
              aria-label="Password"
              onChange={(e) => setField(def.key, e.target.value)}
              className="input"
              style={{ flex: 1 }}
            />
            <button type="button" className="btn-ghost" onClick={() => setShowPassword((v) => !v)}>
              {showPassword ? 'Hide' : 'Show'}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setShowGenerator((v) => !v)}>
              Generate…
            </button>
          </div>
          {value && (
            <div style={{ marginTop: 8 }}>
              <StrengthMeter password={value} />
            </div>
          )}
          {showGenerator && (
            <PasswordGenerator
              onUse={(pw) => {
                setField('password', pw);
                setShowGenerator(false);
              }}
            />
          )}
        </div>
      );
    }
    // API key: masked field with show/hide + copy.
    if (type === 'api_key' && def.key === 'key') {
      return (
        <div key={def.key} style={{ marginTop: 8 }}>
          <label className="label" htmlFor={inputId}>{def.label}</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              id={inputId}
              name={inputName}
              type={showApiKey ? 'text' : 'password'}
              value={value}
              autoComplete="off"
              aria-label="API key"
              onChange={(e) => setField(def.key, e.target.value)}
              className="input"
              style={{ flex: 1 }}
            />
            <button type="button" className="btn-ghost" onClick={() => setShowApiKey((v) => !v)}>
              {showApiKey ? 'Hide' : 'Show'}
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={!value}
              onClick={async () => setApiKeyCopied(await copyText(value))}
            >
              {apiKeyCopied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      );
    }
    if (def.type === 'textarea') {
      return (
        <div key={def.key} style={{ marginTop: 8 }}>
          <label className="label" htmlFor={inputId}>{def.label}</label>
          <textarea
            id={inputId}
            name={inputName}
            value={value}
            placeholder={def.placeholder}
            autoComplete={def.autoComplete ?? 'off'}
            aria-label={def.label}
            onChange={(e) => setField(def.key, e.target.value)}
            rows={def.key === 'private_key' || def.key === 'public_key' ? 5 : 3}
            className="input"
          />
          {type === 'ssh_key' && def.key === 'private_key' && (
            <small className="text-zinc-500">Stored encrypted locally.</small>
          )}
        </div>
      );
    }
    return (
      <div key={def.key} style={{ marginTop: 8 }}>
        <label className="label" htmlFor={inputId}>{def.label}</label>
        <input
          id={inputId}
          name={inputName}
          type={def.type ?? 'text'}
          value={value}
          placeholder={def.placeholder}
          autoComplete={def.autoComplete ?? 'off'}
          aria-label={def.label}
          onChange={(e) => setField(def.key, e.target.value)}
          className="input"
        />
        {type === 'login' && def.key === 'totp_secret' && totpInvalid && (
          <small style={{ color: '#f87171' }}>Invalid TOTP secret.</small>
        )}
      </div>
    );
  };

  return (
    <form onSubmit={handleSave}>
      <h2>{initial ? 'Edit item' : 'New item'}</h2>
      {error && (
        <p role="alert" style={{ color: '#f87171' }}>{error}</p>
      )}
      <div style={{ marginTop: 8 }}>
        <label className="label" htmlFor="item-type">Type</label>
        <select
          id="item-type"
          name="item-type"
          value={type}
          onChange={(e) => handleTypeChange(e.target.value as ItemType)}
          aria-label="Item type"
          className="input"
        >
          {ALL_TYPES.map((t) => (
            <option key={t} value={t}>{TYPE_LABELS[t]}</option>
          ))}
        </select>
      </div>
      <div style={{ marginTop: 8 }}>
        <label className="label" htmlFor="item-title">Title</label>
        <input
          id="item-title"
          name="item-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoComplete="off"
          aria-label="Title"
          className="input"
        />
      </div>
      <div style={{ marginTop: 8 }}>
        <label className="label" htmlFor="item-tags">Tags (comma-separated)</label>
        <input
          id="item-tags"
          name="item-tags"
          type="text"
          value={tagsText}
          placeholder="personal, finance"
          onChange={(e) => setTagsText(e.target.value)}
          autoComplete="off"
          aria-label="Tags, comma-separated"
          className="input"
        />
      </div>
      <div style={{ marginTop: 8 }}>
        <label>
          <input id="item-favorite" name="item-favorite" type="checkbox" checked={favorite} onChange={(e) => setFavorite(e.target.checked)} aria-label="Favorite" /> Favorite
        </label>
      </div>

      {FIELD_DEFS[type].map(renderField)}

      {type === 'custom' && (
        <fieldset style={{ marginTop: 12 }}>
          <legend>Custom fields</legend>
          {customPairs.length === 0 && (
            <p><small className="text-zinc-500">No custom fields yet. Add your own named fields below.</small></p>
          )}
          {customPairs.map((pair, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <div style={{ flex: 1 }}>
                <label className="label" htmlFor={`custom-field-name-${i}`}>Field name</label>
                <input
                  id={`custom-field-name-${i}`}
                  name={`custom-field-name-${i}`}
                  type="text"
                  value={pair.name}
                  placeholder="e.g. membership_id"
                  autoComplete="off"
                  aria-label={`Custom field ${i + 1} name`}
                  onChange={(e) => setCustomPairs((prev) => prev.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)))}
                  className="input"
                />
              </div>
              <div style={{ flex: 2 }}>
                <label className="label" htmlFor={`custom-field-value-${i}`}>Value</label>
                <input
                  id={`custom-field-value-${i}`}
                  name={`custom-field-value-${i}`}
                  type="text"
                  value={pair.value}
                  autoComplete="off"
                  aria-label={`Custom field ${i + 1} value`}
                  onChange={(e) => setCustomPairs((prev) => prev.map((p, j) => (j === i ? { ...p, value: e.target.value } : p)))}
                  className="input"
                />
              </div>
              <button type="button" className="btn-ghost" style={{ alignSelf: 'flex-end' }} onClick={() => setCustomPairs((prev) => prev.filter((_, j) => j !== i))} aria-label={`Remove custom field ${i + 1}`}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" className="btn-ghost" style={{ marginTop: 8 }} onClick={() => setCustomPairs((prev) => [...prev, { name: '', value: '' }])}>
            + Add custom field
          </button>
        </fieldset>
      )}

      {type === 'card' && (
        <p style={{ marginTop: 8 }}><small className="text-zinc-500">CVV/PIN are never stored.</small></p>
      )}

      {(type === 'media' || type === 'document') && (
        <div style={{ marginTop: 12 }} className="card p-4">
          <label className="label" htmlFor={`${type}-file`}>Attach file (manifest only)</label>
          <input
            id={`${type}-file`}
            name={`${type}-file`}
            type="file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
            aria-label={`Attach ${type} file`}
            style={{ display: 'block', marginTop: 4 }}
          />
          <p><small className="text-zinc-500">Manifest only — file bytes are not stored in this local prototype. Only the file name, type, size and SHA-256 hash are kept.</small></p>
          {fieldValue('sha256') && (
            <p><small>SHA-256: <code style={{ wordBreak: 'break-all' }}>{fieldValue('sha256')}</code></small></p>
          )}
        </div>
      )}

      {relationCandidates.length > 0 && (
        <fieldset style={{ marginTop: 12 }}>
          <legend>Relations</legend>
          {relationCandidates.map((candidate) => (
            <label key={candidate.id} style={{ display: 'block' }}>
              <input
                id={`relation-${candidate.id}`}
                name={`relation-${candidate.id}`}
                type="checkbox"
                checked={relationIds.includes(candidate.id)}
                onChange={(e) => {
                  setRelationIds((prev) =>
                    e.target.checked
                      ? [...prev, candidate.id]
                      : prev.filter((id) => id !== candidate.id),
                  );
                }}
                aria-label={`Relate to ${candidate.title}`}
              />{' '}
              {candidate.title} <small>({candidate.type})</small>
            </label>
          ))}
        </fieldset>
      )}

      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
