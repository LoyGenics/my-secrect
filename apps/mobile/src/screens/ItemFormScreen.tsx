import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { ItemType, VaultItem } from '../../../../packages/core/src/types';
import Field from '../components/Field';
import StrengthMeter from '../components/StrengthMeter';
import MarkdownText from '../components/MarkdownText';
import { useMobileTheme } from '../theme';
import { Icon } from '../../../../packages/ui/src/native';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { Action, Group, Page, Row, Rule, Select, ToggleRow } from '../components/mobile-ui';
import { libsodiumAdapter as crypto } from '../../../../packages/crypto-adapters/src/index';
import { generatePassword } from '../utils/password';
import { getPasswordHistory, appendPasswordHistory, getNoteRevisions, appendNoteRevision } from '../utils/itemMeta';

const TYPES: Array<{ type: ItemType; label: string }> = [
  { type: 'login', label: 'Login' }, { type: 'passkey', label: 'Passkey' },
  { type: 'bank_account', label: 'Bank account' }, { type: 'card', label: 'Card' },
  { type: 'identity', label: 'Identity' }, { type: 'ssh_key', label: 'SSH key' },
  { type: 'api_key', label: 'API key' }, { type: 'secure_note', label: 'Secure note' },
  { type: 'document', label: 'Document' }, { type: 'media', label: 'Media' },
  { type: 'collection', label: 'Collection' }, { type: 'custom', label: 'Custom' },
];
const FIELDS: Record<ItemType, Array<{ key: string; label: string; secret?: boolean; multiline?: boolean; placeholder?: string }>> = {
  login: [{ key: 'username', label: 'Username / email' }, { key: 'password', label: 'Password', secret: true }, { key: 'url', label: 'Website URL' }, { key: 'totp_secret', label: 'TOTP secret (base32)', placeholder: 'JBSWY3DPEHPK3PXP' }, { key: 'notes', label: 'Notes', multiline: true }],
  passkey: [{ key: 'credential_id', label: 'Credential ID' }, { key: 'rp_id', label: 'Relying party (domain)' }, { key: 'notes', label: 'Notes', multiline: true }],
  bank_account: [{ key: 'bank_name', label: 'Bank name' }, { key: 'account_number', label: 'Account number', secret: true }, { key: 'currency', label: 'Currency', placeholder: 'VND' }, { key: 'holder_name', label: 'Account holder' }, { key: 'branch', label: 'Branch' }, { key: 'notes', label: 'Notes', multiline: true }],
  card: [{ key: 'cardholder', label: 'Cardholder' }, { key: 'last4', label: 'Last 4 digits', placeholder: '4242' }, { key: 'brand', label: 'Brand', placeholder: 'Visa' }, { key: 'expiry', label: 'Expiry', placeholder: '2030-12' }, { key: 'bank', label: 'Bank' }, { key: 'notes', label: 'Notes', multiline: true }],
  identity: [{ key: 'full_name', label: 'Full name' }, { key: 'document_number', label: 'Document number', secret: true }, { key: 'issued_date', label: 'Issued date', placeholder: '2020-01-01' }, { key: 'expiry_date', label: 'Expiry date', placeholder: '2030-01-01' }, { key: 'notes', label: 'Notes', multiline: true }],
  ssh_key: [{ key: 'public_key', label: 'Public key', multiline: true }, { key: 'private_key_ref', label: 'Private key reference', secret: true, placeholder: 'Stored encrypted — paste the key itself only if you understand the risk' }, { key: 'comment', label: 'Comment' }, { key: 'notes', label: 'Notes', multiline: true }],
  api_key: [{ key: 'service', label: 'Service' }, { key: 'key', label: 'API key', secret: true }, { key: 'scopes', label: 'Scopes' }, { key: 'expires_at', label: 'Expires', placeholder: '2027-01-01' }, { key: 'notes', label: 'Notes', multiline: true }],
  secure_note: [{ key: 'body', label: 'Note', multiline: true }],
  document: [{ key: 'blob_id', label: 'Blob ID' }, { key: 'mime_type', label: 'MIME type', placeholder: 'application/pdf' }, { key: 'notes', label: 'Notes', multiline: true }],
  media: [{ key: 'blob_id', label: 'Blob ID' }, { key: 'mime_type', label: 'MIME type', placeholder: 'image/jpeg' }, { key: 'width', label: 'Width' }, { key: 'height', label: 'Height' }, { key: 'duration_s', label: 'Duration (seconds)' }, { key: 'notes', label: 'Notes', multiline: true }],
  collection: [{ key: 'description', label: 'Description', multiline: true }],
  custom: [{ key: 'description', label: 'Description', multiline: true }],
};

function newItemId(): string {
  const b = crypto.randomBytes(16);
  return 'item_' + Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

export default function ItemFormScreen({ initial, allItems, onSave, onCancel, onDirtyChange }: {
  initial?: VaultItem; allItems: VaultItem[];
  onSave: (item: VaultItem) => void | Promise<void>; onCancel: () => void; onDirtyChange?: (dirty: boolean) => void;
}) {
  const { colors, styles } = useMobileTheme();
  const { dict, t } = useTranslation();
  const [more, setMore] = useState(false);
  const [relationsOpen, setRelationsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [type, setType] = useState<ItemType>(initial?.type ?? 'login');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [fields, setFields] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(initial?.fields ?? {})) if (typeof v === 'string') out[k] = v;
    return out;
  });
  const [customKey, setCustomKey] = useState('');
  const [customValue, setCustomValue] = useState('');
  const [tagsText, setTagsText] = useState((initial?.tags ?? []).join(', '));
  const [relationIds, setRelationIds] = useState<string[]>((initial?.relations ?? []).map((r) => r.target_id));
  const [favorite, setFavorite] = useState(initial?.favorite ?? false);
  const [error, setError] = useState('');
  // Nested collections: a collection may live inside another collection.
  const [parentId, setParentId] = useState<string>(
    () => (typeof initial?.fields?.parent_id === 'string' ? (initial.fields.parent_id as string) : ''),
  );
  const [showPreview, setShowPreview] = useState(false);
  const setF = (key: string, value: string) => setFields((f) => ({ ...f, [key]: value }));
  const relatable = allItems.filter((i) => i.id !== initial?.id);
  const parentCandidates = allItems.filter((i) => i.type === 'collection' && i.id !== initial?.id);

  const signature = JSON.stringify({ type, title, fields, tagsText, relationIds, favorite, parentId, customKey, customValue });
  const baseline = useRef(signature);
  useEffect(() => { onDirtyChange?.(signature !== baseline.current); }, [signature, onDirtyChange]);

  async function handleSave() {
    if (!title.trim()) { setError('Title is required.'); return; }
    if (type === 'login' && !(fields.username ?? '').trim()) { setError('Username is required for a login.'); return; }
    if (type === 'bank_account' && !(fields.bank_name ?? '').trim()) { setError('Bank name is required.'); return; }
    const now = new Date().toISOString();
    // Trim string fields and drop empties (previously empty strings were stored as fields).
    const cleaned: Record<string, unknown> = Object.fromEntries(Object.entries(initial?.fields ?? {}).filter(([, value]) => typeof value !== 'string'));
    for (const [k, v] of Object.entries(fields)) {
      const t = v.trim();
      if (t !== '') cleaned[k] = t;
    }
    if (initial) {
      // Carry encrypted metadata the form does not edit, and record
      // history on change — otherwise every edit would erase them.
      if (initial.fields?.archived === true) cleaned.archived = true;
      const prevHistory = getPasswordHistory(initial);
      if (prevHistory.length > 0) cleaned.password_history = prevHistory;
      const prevRevisions = getNoteRevisions(initial);
      if (prevRevisions.length > 0) cleaned.revisions = prevRevisions;
      if (type === 'login') {
        const oldPw = typeof initial.fields?.password === 'string' ? (initial.fields.password as string) : '';
        const newPw = typeof cleaned.password === 'string' ? (cleaned.password as string) : '';
        if (oldPw && newPw && oldPw !== newPw) cleaned.password_history = appendPasswordHistory(prevHistory, oldPw, now);
      }
      if (type === 'secure_note') {
        const oldBody = typeof initial.fields?.body === 'string' ? (initial.fields.body as string) : '';
        const newBody = typeof cleaned.body === 'string' ? (cleaned.body as string) : '';
        if (oldBody && newBody && oldBody !== newBody) cleaned.revisions = appendNoteRevision(prevRevisions, oldBody, now);
      }
    }
    // The parent selector owns parent_id: without the delete below,
    // clearing the parent would leave the stale value from `fields`.
    if (type === 'collection') {
      if (parentId) cleaned.parent_id = parentId;
      else delete cleaned.parent_id;
    }
    const item: VaultItem = {
      id: initial?.id ?? newItemId(), type, schema_version: 1, title: title.trim(),
      fields: cleaned,
      tags: tagsText.split(',').map((t) => t.trim()).filter(Boolean),
      // Keep existing relation types; only newly linked items default to related_to.
      relations: relationIds.map((id) => (initial?.relations ?? []).find((r) => r.target_id === id) ?? { type: 'related_to', target_id: id }),
      attachments: initial?.attachments ?? [], favorite,
      created_at: initial?.created_at ?? now, updated_at: now,
    };
    setSaving(true); setError('');
    try { await onSave(item); } catch (e) { setError(t('mobileUI.saveFailed')); } finally { setSaving(false); }
  }
  return <Page>
    <Group title={dict.itemForm.type}>
      <View style={{ paddingHorizontal: 16 }}><Select testID="item-type" label={t('mobileUI.itemType')} value={type} choices={TYPES.filter(option => !['media', 'document', 'collection'].includes(option.type) || option.type === initial?.type).map(option => ({ value: option.type, label: (dict.itemTypes as Record<string, string>)[option.type] ?? option.label }))} onChange={value => setType(value as ItemType)} /></View>
    </Group>
    <Field label={dict.itemForm.title} testID="item-title" placeholder="e.g. Example Mail" value={title} onChangeText={setTitle} autoCapitalize="sentences" />
    {FIELDS[type].map(fd => <View key={fd.key}>
      <Field label={(dict.fields as Record<string, string>)[fd.key] ?? fd.label} testID={`field-${fd.key}`} placeholder={fd.placeholder} secureTextEntry={fd.secret} multiline={fd.multiline} value={fields[fd.key] ?? ''} onChangeText={value => setF(fd.key, value)} autoCapitalize="none" autoCorrect={false} />
      {fd.key === 'password' && <View style={{ marginBottom: 18 }}>
        {!!fields.password && <StrengthMeter password={fields.password} />}
        <Row testID="generate-password-button" label={dict.itemForm.generate} onPress={() => { try { setF('password', generatePassword({ length: 20 })); } catch (e) { setError(e instanceof Error ? e.message : t('mobileUI.saveFailed')); } }} />
      </View>}
      {type === 'secure_note' && fd.key === 'body' && <View style={{ marginBottom: 18 }}>
        <Row testID="preview-markdown-button" label={showPreview ? dict.itemForm.hidePreview : dict.itemForm.preview} onPress={() => setShowPreview(v => !v)} />
        {showPreview && <View style={{ backgroundColor: colors.card, padding: 16, borderRadius: 12, marginTop: 10 }}><MarkdownText source={fields.body ?? ''} /></View>}
      </View>}
    </View>)}
    {type === 'card' && <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19, marginBottom: 20 }}>{dict.mobile.cardNote}</Text>}
    {type === 'collection' && <Group title={dict.itemForm.parentAria}><View style={{ paddingHorizontal: 16 }}><Select testID="item-parent" label={dict.itemForm.parentAria} value={parentId} choices={[{ value: '', label: t('mobileUI.noParent') }, ...parentCandidates.map(item => ({ value: item.id, label: item.title }))]} onChange={setParentId} /></View></Group>}
    <Group>
      <ToggleRow testID="item-favorite-toggle" label={dict.itemForm.favorite} value={favorite} onChange={setFavorite} />
      <Rule /><Row testID="item-more-options" label={t('mobileUI.moreOptions')} onPress={() => setMore(v => !v)} />
    </Group>
    {more && <View>
      <Field label={dict.itemForm.tags} testID="item-tags" placeholder="personal, finance" value={tagsText} onChangeText={setTagsText} autoCapitalize="none" />
      <Group title={t('mobileUI.customFields')}>
        <View style={{ padding: 16 }}>
          {Object.keys(fields).filter(key => !FIELDS[type].some(fd => fd.key === key) && !['parent_id','password_history','revisions','archived'].includes(key)).map(key => <Field key={key} testID={`custom-${key}`} label={key} value={fields[key]} onChangeText={value => setF(key, value)} autoCapitalize="none" />)}
          <Field label={dict.itemForm.customName} testID="custom-field-name" value={customKey} onChangeText={setCustomKey} autoCapitalize="none" />
          <Field label={dict.itemForm.customValue} testID="custom-field-value" value={customValue} onChangeText={setCustomValue} autoCapitalize="none" />
          <Action testID="add-custom-field" label={dict.itemForm.addCustom} secondary disabled={!customKey.trim() || !customValue.trim()} onPress={() => { setF(customKey.trim(), customValue.trim()); setCustomKey(''); setCustomValue(''); }} />
        </View>
      </Group>
      {!!relatable.length && <Group title={t('mobileUI.relatedItems')}>
        <Row testID="item-relations" label={t('mobileUI.relatedItems')} detail={t('mobileUI.itemCount', relationIds.length)} onPress={() => setRelationsOpen(v => !v)} />
        {relationsOpen && relatable.map(item => <ToggleRow key={item.id} testID={`relation-${item.id}`} label={item.title} value={relationIds.includes(item.id)} onChange={value => setRelationIds(ids => value ? [...ids, item.id] : ids.filter(id => id !== item.id))} />)}
      </Group>}
    </View>}
    {!!error && <Text testID="form-error" accessibilityRole="alert" style={[styles.error, { marginBottom: 16 }]}>{error}</Text>}
    <Action testID="save-item-button" label={saving ? dict.itemForm.saving : dict.itemForm.save} disabled={saving} onPress={() => void handleSave()} />
    <View style={{ marginTop: 12 }}><Action testID="cancel-item-button" label={dict.common.cancel} secondary disabled={saving} onPress={onCancel} /></View>
  </Page>;
}
