import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { VaultItem } from '../../../../packages/core/src/types';
import { colors, styles } from '../theme';
import { typeLabel } from '../components/ItemRow';
import MarkdownText from '../components/MarkdownText';
import { generateTotp } from '../utils/totp';
import { getPasswordHistory, getNoteRevisions, isArchived } from '../utils/itemMeta';

function FieldRow({ label, value, secret, testID }: { label: string; value: string; secret?: boolean; testID: string }) {
  const [show, setShow] = useState(false);
  const display = secret && !show ? '•'.repeat(Math.min(12, Math.max(4, value.length))) : value;
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={styles.label}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.input, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 48 }}>
        <Text selectable style={{ flex: 1, color: colors.text, fontSize: 15 }} numberOfLines={secret && !show ? 1 : undefined}>{display}</Text>
        {secret ? (
          <Pressable testID={`${testID}-toggle`} accessibilityLabel={show ? `Hide ${label}` : `Show ${label}`} onPress={() => setShow((v) => !v)} hitSlop={10} style={{ padding: 6 }}><Text style={{ color: '#A5B4FC', fontSize: 13, fontWeight: '600' }}>{show ? 'Hide' : 'Show'}</Text></Pressable>
        ) : null}
        <Pressable testID={`${testID}-copy`} accessibilityLabel={`Copy ${label}`} onPress={() => { void Clipboard.setStringAsync(value); }} hitSlop={10} style={{ padding: 6 }}><Text style={{ color: '#A5B4FC', fontSize: 13, fontWeight: '600' }}>Copy</Text></Pressable>
      </View>
    </View>
  );
}

export default function ItemDetailScreen({ item, allItems, inTrash, onEdit, onDelete, onRestore, onToggleFavorite, onClose, onSelectRelated }: {
  item: VaultItem; allItems: VaultItem[]; inTrash: boolean;
  onEdit: () => void; onDelete: () => void; onRestore: () => void; onToggleFavorite: () => void; onClose: () => void; onSelectRelated: (id: string) => void;
}) {
  const f = item.fields as Record<string, unknown>;
  const str = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : '');
  const [totp, setTotp] = useState('');
  const [totpLeft, setTotpLeft] = useState(30);
  useEffect(() => {
    const secret = str('totp_secret'); if (!secret) return;
    const tick = () => { const r = generateTotp(secret); setTotp(r.code); setTotpLeft(r.secondsRemaining); };
    tick(); const id = setInterval(tick, 1000); return () => clearInterval(id);
  }, [item.id]);
  const related = (item.relations ?? []).map((r) => allItems.find((i) => i.id === r.target_id)).filter((i): i is VaultItem => !!i);
  const archived = isArchived(item);
  const passwordHistory = item.type === 'login' ? getPasswordHistory(item) : [];
  const revisions = item.type === 'secure_note' ? getNoteRevisions(item) : [];
  const parentId = typeof f.parent_id === 'string' ? (f.parent_id as string) : '';
  const parent = parentId ? allItems.find((c) => c.id === parentId) : undefined;
  const children = item.type === 'collection' ? allItems.filter((c) => typeof c.fields?.parent_id === 'string' && c.fields.parent_id === item.id) : [];
  const entries: Array<[string, string, boolean]> = [];
  const add = (label: string, key: string, secret = false) => { const v = str(key); if (v) entries.push([label, v, secret]); };
  if (item.type === 'login' || item.type === 'passkey') { add('Username', 'username'); add('Password', 'password', true); add('Website', 'url'); add('Credential ID', 'credential_id'); add('RP ID', 'rp_id'); add('Notes', 'notes'); }
  if (item.type === 'bank_account') { add('Bank', 'bank_name'); add('Account number', 'account_number', true); add('Currency', 'currency'); add('Holder', 'holder_name'); add('Branch', 'branch'); add('Notes', 'notes'); }
  if (item.type === 'card') { add('Cardholder', 'cardholder'); add('Last 4', 'last4'); add('Brand', 'brand'); add('Expiry', 'expiry'); add('Bank', 'bank'); add('Notes', 'notes'); }
  if (item.type === 'identity') { add('Full name', 'full_name'); add('Document number', 'document_number', true); add('Issued', 'issued_date'); add('Expiry', 'expiry_date'); add('Notes', 'notes'); }
  if (item.type === 'ssh_key') { add('Public key', 'public_key'); add('Private key reference', 'private_key_ref', true); add('Comment', 'comment'); add('Notes', 'notes'); }
  if (item.type === 'api_key') { add('Service', 'service'); add('Key', 'key', true); add('Scopes', 'scopes'); add('Expires', 'expires_at'); add('Notes', 'notes'); }
  if (item.type === 'secure_note') { add('Body', 'body'); }
  if (item.type === 'document' || item.type === 'media') { add('Blob ID', 'blob_id'); add('MIME type', 'mime_type'); if (item.type === 'media') { add('Width', 'width'); add('Height', 'height'); add('Duration (s)', 'duration_s'); } add('Notes', 'notes'); }
  if (item.type === 'collection' || item.type === 'custom') { add('Description', 'description'); for (const [k, v] of Object.entries(f)) if (typeof v === 'string' && v && k !== 'description') entries.push([k, v, false]); }
  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16 }}>
      <Pressable testID="detail-back" accessibilityLabel="Back to vault" onPress={onClose} hitSlop={10} style={{ alignSelf: 'flex-start', paddingVertical: 8 }}><Text style={{ color: '#A5B4FC', fontSize: 15 }}>‹ Back</Text></Pressable>
      <Text style={styles.title}>{item.title}</Text>
      <Text style={{ color: colors.muted, fontSize: 14, marginTop: 4 }}>{typeLabel(item.type)}{item.favorite ? '  ★ Favorite' : ''}{inTrash ? '  • In Trash' : ''}{archived ? '  • 📦 Archived' : ''}</Text>
      {parent ? (
        <Pressable testID="detail-parent" accessibilityLabel={`Open parent collection ${parent.title}`} onPress={() => onSelectRelated(parent.id)} style={{ marginTop: 6 }}>
          <Text style={{ color: '#A5B4FC', fontSize: 14 }}>In collection: {parent.title} ›</Text>
        </Pressable>
      ) : null}
      {str('totp_secret') ? (
        <View style={{ backgroundColor: colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 14, padding: 14, marginTop: 16 }}>
          <Text style={styles.label}>Authenticator (TOTP)</Text>
          <Text testID="totp-code" accessibilityLabel={`One-time code ${totp}`} style={{ color: colors.text, fontSize: 28, fontWeight: '700', letterSpacing: 4 }}>{totp || 'Invalid TOTP secret'}</Text>
          <Text style={{ color: colors.muted, fontSize: 12, marginTop: 4 }}>Refreshes in {totpLeft}s · 30-second period</Text>
          <Pressable testID="totp-copy" accessibilityLabel="Copy one-time code" style={[styles.ghostButton, { marginTop: 10 }]} onPress={() => { void Clipboard.setStringAsync(totp); }}><Text style={styles.ghostButtonText}>Copy code</Text></Pressable>
        </View>
      ) : null}
      <View style={{ marginTop: 16 }}>
        {entries.map(([label, value, secret]) =>
          item.type === 'secure_note' && label === 'Body' ? (
            <View key={label} style={{ marginBottom: 14 }}>
              <Text style={styles.label}>Note</Text>
              <View style={{ backgroundColor: colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, padding: 12 }}>
                <MarkdownText source={value} />
              </View>
            </View>
          ) : (
            <FieldRow key={label} label={label} value={value} secret={secret} testID={`field-${label}`} />
          ),
        )}
        {entries.length === 0 ? <Text style={{ color: colors.muted }}>No fields saved for this item.</Text> : null}
      </View>
      {passwordHistory.length > 0 ? (
        <View style={{ marginTop: 20 }}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 8 }}>Previous passwords</Text>
          <Text style={{ color: colors.muted, fontSize: 13, marginBottom: 10 }}>Kept encrypted with this item (max 5). The current password is above.</Text>
          {passwordHistory.map((entry, i) => (
            <FieldRow key={i} label={`Changed ${new Date(entry.changed_at).toLocaleString()}`} value={entry.password} secret testID={`history-${i}`} />
          ))}
        </View>
      ) : null}
      {revisions.length > 0 ? (
        <View style={{ marginTop: 20 }}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 8 }}>Note revisions</Text>
          <Text style={{ color: colors.muted, fontSize: 13, marginBottom: 10 }}>Previous versions of this note (max 10). Restoring a revision is done on desktop — here you can copy an old version and paste it into Edit.</Text>
          {revisions.map((rev, i) => (
            <View key={i} style={{ backgroundColor: colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 8 }}>
              <Text style={{ color: colors.muted, fontSize: 12 }}>Saved {new Date(rev.saved_at).toLocaleString()}</Text>
              <Text style={{ color: colors.text, fontSize: 14, lineHeight: 19, marginTop: 6 }} numberOfLines={4}>{rev.body}</Text>
              <Pressable testID={`revision-copy-${i}`} accessibilityLabel="Copy this revision" style={[styles.ghostButton, { marginTop: 8 }]} onPress={() => { void Clipboard.setStringAsync(rev.body); }}>
                <Text style={styles.ghostButtonText}>Copy this version</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      {children.length > 0 ? (
        <View style={{ marginTop: 20 }}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 8 }}>Inside this collection</Text>
          {children.map((child) => (
            <Pressable key={child.id} testID={`child-${child.id}`} accessibilityLabel={`Open ${child.title}`} onPress={() => onSelectRelated(child.id)} style={{ backgroundColor: colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 8 }}>
              <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>{child.title}</Text>
              <Text style={{ color: colors.muted, fontSize: 13 }}>{typeLabel(child.type)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {(item.tags ?? []).length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 }}>{item.tags.map((t) => (<View key={t} style={styles.chip}><Text style={styles.chipText}>#{t}</Text></View>))}</View>
      )}
      {related.length > 0 && (
        <View style={{ marginTop: 20 }}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 8 }}>Related items</Text>
          {related.map((r) => (
            <Pressable key={r.id} testID={`related-${r.id}`} accessibilityLabel={`Open related item ${r.title}`} onPress={() => onSelectRelated(r.id)} style={{ backgroundColor: colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 8 }}>
              <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>{r.title}</Text>
              <Text style={{ color: colors.muted, fontSize: 13 }}>{typeLabel(r.type)}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {item.type === 'card' ? <Text style={{ color: colors.warn, fontSize: 13, lineHeight: 18, marginTop: 12 }}>Card metadata only — CVV and PIN are never stored.</Text> : null}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
        {!inTrash ? <Pressable testID="detail-edit" accessibilityLabel="Edit item" style={[styles.primaryButton, { flex: 1 }]} onPress={onEdit}><Text style={styles.primaryButtonText}>Edit</Text></Pressable> : null}
        <Pressable testID="detail-favorite" accessibilityLabel={item.favorite ? 'Remove from favorites' : 'Add to favorites'} style={[styles.ghostButton, { flex: 1 }]} onPress={onToggleFavorite}><Text style={styles.ghostButtonText}>{item.favorite ? '★ Favorited' : '☆ Favorite'}</Text></Pressable>
      </View>
      {inTrash ? (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
          <Pressable testID="detail-restore" accessibilityLabel="Restore item" style={[styles.primaryButton, { flex: 1 }]} onPress={onRestore}><Text style={styles.primaryButtonText}>Restore</Text></Pressable>
          <Pressable testID="detail-delete-permanent" accessibilityLabel="Delete permanently" style={[styles.dangerButton, { flex: 1 }]} onPress={() => Alert.alert('Delete permanently?', 'This cannot be undone.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: onDelete }])}><Text style={styles.primaryButtonText}>Delete forever</Text></Pressable>
        </View>
      ) : (
        <Pressable testID="detail-delete" accessibilityLabel="Move to trash" style={[styles.ghostButton, { marginTop: 10, borderColor: colors.danger }]} onPress={() => Alert.alert('Move to Trash?', 'You can restore it from Trash later.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Move to Trash', style: 'destructive', onPress: onDelete }])}>
          <Text style={[styles.ghostButtonText, { color: colors.danger }]}>Move to Trash</Text>
        </Pressable>
      )}
      <Text style={{ color: colors.faint, fontSize: 12, marginTop: 16 }}>Created {new Date(item.created_at).toLocaleString()} · Updated {new Date(item.updated_at).toLocaleString()}</Text>
    </ScrollView>
  );
}
