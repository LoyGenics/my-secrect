import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { ItemType, VaultItem } from '../../../../packages/core/src/types';
import Field from '../components/Field';
import StrengthMeter from '../components/StrengthMeter';
import MarkdownText from '../components/MarkdownText';
import { useMobileTheme } from '../theme';
import { Icon, illustrations, typeArt } from '../../../../packages/ui/src/native';
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

export default function ItemFormScreen({ initial, allItems, onSave, onCancel }: {
  initial?: VaultItem; allItems: VaultItem[];
  onSave: (item: VaultItem) => void; onCancel: () => void;
}) {
  const { colors, styles } = useMobileTheme();
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

  function handleSave() {
    if (!title.trim()) { setError('Title is required.'); return; }
    if (type === 'login' && !(fields.username ?? '').trim()) { setError('Username is required for a login.'); return; }
    if (type === 'bank_account' && !(fields.bank_name ?? '').trim()) { setError('Bank name is required.'); return; }
    const now = new Date().toISOString();
    // Trim string fields and drop empties (previously empty strings were stored as fields).
    const cleaned: Record<string, unknown> = {};
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
    onSave(item);
  }
  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>{initial ? 'Edit item' : 'New item'}</Text>
      <Text style={[styles.label, { marginTop: 16 }]}>Type</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {TYPES.map((t) => (
          <Pressable key={t.type} testID={`type-${t.type}`} accessibilityLabel={`Type ${t.label}`} accessibilityRole="button" onPress={() => setType(t.type)} style={{ backgroundColor: type === t.type ? colors.accent : colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, marginRight: 6, marginBottom: 6 }}>
            <Text style={{ color: type === t.type ? colors.onAccent : colors.text, fontSize: 13, fontWeight: '600' }}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
      <Field label="Title" testID="item-title" placeholder="e.g. Example Mail" value={title} onChangeText={setTitle} autoCapitalize="none" />
      {FIELDS[type].map((fd) => (
        <View key={fd.key}>
          <Field label={fd.label} testID={`field-${fd.key}`} placeholder={fd.placeholder} secureTextEntry={fd.secret} multiline={fd.multiline} value={fields[fd.key] ?? ''} onChangeText={(v) => setF(fd.key, v)} autoCapitalize="none" autoCorrect={false} />
          {fd.key === 'password' ? (
            <View>
              {fields.password ? <StrengthMeter password={fields.password} /> : null}
              <Pressable testID="generate-password-button" accessibilityLabel="Generate a password" style={[styles.ghostButton, { marginTop: -6, marginBottom: 14 }]} onPress={() => { try { setF('password', generatePassword({ length: 16 })); } catch (e) { setError(e instanceof Error ? e.message : 'Could not generate a password.'); } }}>
                <Text style={styles.ghostButtonText}>Generate password</Text>
              </Pressable>
            </View>
          ) : null}
          {type === 'secure_note' && fd.key === 'body' ? (
            <View style={{ marginBottom: 14 }}>
              <Pressable testID="preview-markdown-button" accessibilityLabel="Preview note as Markdown" style={[styles.ghostButton, { marginTop: -6 }]} onPress={() => setShowPreview((v) => !v)}>
                <Text style={styles.ghostButtonText}>{showPreview ? 'Hide preview' : 'Preview Markdown'}</Text>
              </Pressable>
              {showPreview ? (
                <View style={{ backgroundColor: colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 10 }}>
                  <MarkdownText source={fields.body ?? ''} />
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      ))}
      {type === 'collection' ? (
        <View style={{ marginBottom: 14 }}>
          <Text style={styles.label}>Parent collection (optional — nested folders)</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            <Pressable testID="parent-none" accessibilityLabel="No parent collection" onPress={() => setParentId('')} style={{ backgroundColor: parentId === '' ? colors.accent : colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, marginRight: 6, marginBottom: 6 }}>
              <Text style={{ color: parentId === '' ? colors.onAccent : colors.text, fontSize: 13, fontWeight: '600' }}>None — top level</Text>
            </Pressable>
            {parentCandidates.map((c) => (
              <Pressable key={c.id} testID={`parent-${c.id}`} accessibilityLabel={`Parent collection ${c.title}`} onPress={() => setParentId(c.id)} style={{ backgroundColor: parentId === c.id ? colors.accent : colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, marginRight: 6, marginBottom: 6 }}>
                <Text style={{ color: parentId === c.id ? colors.onAccent : colors.text, fontSize: 13, fontWeight: '600' }}>{c.title}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
      {type === 'card' ? <Text style={{ color: colors.warn, fontSize: 13, lineHeight: 18, marginBottom: 14 }}>Card metadata only — never enter a CVV or PIN. There is no field for them, by design.</Text> : null}
      <Field label="Tags (comma separated)" testID="item-tags" placeholder="personal, finance" value={tagsText} onChangeText={setTagsText} autoCapitalize="none" />
      <Text style={styles.label}>Custom field</Text>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 6 }}>
        <View style={{ flex: 1 }}><Field label="Field name" testID="custom-field-name" placeholder="e.g. recovery_email" value={customKey} onChangeText={setCustomKey} autoCapitalize="none" /></View>
        <View style={{ flex: 1 }}><Field label="Value" testID="custom-field-value" placeholder="value" value={customValue} onChangeText={setCustomValue} autoCapitalize="none" /></View>
      </View>
      <Pressable testID="add-custom-field" accessibilityLabel="Add custom field" style={[styles.ghostButton, { marginBottom: 14 }]} onPress={() => { if (customKey.trim() && customValue.trim()) { setF(customKey.trim(), customValue.trim()); setCustomKey(''); setCustomValue(''); } }}>
        <Text style={styles.ghostButtonText}>Add custom field</Text>
      </Pressable>
      {relatable.length > 0 ? (
        <View style={{ marginBottom: 14 }}>
          <Text style={styles.label}>Related items</Text>
          {relatable.map((r) => {
            const on = relationIds.includes(r.id);
            return (
              <Pressable key={r.id} testID={`relation-${r.id}`} accessibilityLabel={`Link to ${r.title}`} accessibilityRole="checkbox" accessibilityState={{ checked: on }} onPress={() => setRelationIds((ids) => (on ? ids.filter((x) => x !== r.id) : [...ids, r.id]))} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 6 }}>
                <View style={{ width: 22, height: 22, borderRadius: 4, borderWidth: 1, borderColor: on ? colors.text : colors.control, backgroundColor: on ? colors.text : colors.input, alignItems: 'center', justifyContent: 'center' }}>{on ? <Icon name="check" size="sm" color={colors.bg} /> : null}</View>
                <Text style={{ color: colors.text, fontSize: 15, flex: 1 }}>{r.title}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <Pressable testID="item-favorite-toggle" accessibilityLabel={favorite ? 'Remove from favorites' : 'Add to favorites'} accessibilityRole="checkbox" accessibilityState={{ checked: favorite }} onPress={() => setFavorite((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <Icon name="favorite" size="lg" color={favorite ? colors.warn : colors.muted} />
        <Text style={{ color: colors.text, fontSize: 15 }}>Favorite</Text>
      </Pressable>
      {error ? <Text testID="form-error" style={[styles.error, { marginBottom: 12 }]}>{error}</Text> : null}
      <Pressable testID="save-item-button" accessibilityLabel="Save item" accessibilityRole="button" style={styles.primaryButton} onPress={handleSave}>
        <Text style={styles.primaryButtonText}>Save item</Text>
      </Pressable>
      <Pressable testID="cancel-item-button" accessibilityLabel="Cancel" style={[styles.ghostButton, { marginTop: 10 }]} onPress={onCancel}>
        <Text style={styles.ghostButtonText}>Cancel</Text>
      </Pressable>
    </ScrollView>
  );
}
