import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import React, { useEffect, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import * as Clipboard from 'expo-clipboard';
import type { VaultItem } from '../../../../packages/core/src/types';
import { cardIssuer, cardLast4 } from '../../../../packages/core/src/card';
import { useMobileTheme } from '../theme';
import { Icon, TypeModule } from '../../../../packages/ui/src/native';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { format, plural, formatDate } from '../../../../packages/i18n/src/index';
import { typeLabel } from '../components/ItemRow';
import MarkdownText from '../components/MarkdownText';
import { IconButton } from '../components/mobile-ui';
import ScreenFrame from '../components/ScreenFrame';
import { generateTotp } from '../utils/totp';
import { getPasswordHistory, getNoteRevisions, isArchived } from '../utils/itemMeta';
import { readLocalCardCode } from '../vault';

/** Fields that hold the secret, in the order "Copy password" prefers. */
const SECRET_KEYS = ['password', 'key', 'account_number', 'document_number', 'private_key_ref'];

/** Thin countdown ring for the one-time code (remaining share 0–100). */
function Ring({ value, color, track }: { value: number; color: string; track: string }) {
  const size = 36;
  const stroke = 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <Svg width={size} height={size} accessible={false} importantForAccessibility="no-hide-descendants" style={{ transform: [{ rotate: '-90deg' }] }}>
      <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
      <Circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c - (c * value) / 100} />
    </Svg>
  );
}

function FieldRow({ label, value, secret, mask, copyable = true, testID }: { label: string; value: string; secret?: boolean; mask?: string; copyable?: boolean; testID: string }) {
  const { colors } = useMobileTheme();
  const { dict } = useTranslation();
  const [show, setShow] = useState(false);
  const display = secret && !show ? mask ?? '•'.repeat(Math.min(12, Math.max(4, value.length))) : value;
  return (
    <View style={{ paddingVertical: 12, paddingHorizontal: 16, borderTopColor: colors.cardBorder, borderTopWidth: 1 }}>
      <Text style={{ color: colors.muted, fontSize: 13, marginBottom: 4 }}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text selectable={copyable} style={{ flex: 1, color: colors.text, fontSize: 16 }} numberOfLines={secret && !show ? 1 : undefined}>{display}</Text>
        {secret ? (
          <IconButton testID={`${testID}-toggle`} accessibilityLabel={format(show ? dict.itemDetail.hide : dict.itemDetail.show, label)} onPress={() => setShow((v) => !v)}><Icon name={show ? 'hide' : 'show'} size="lg" color={colors.secondary} /></IconButton>
        ) : null}
        {copyable && <IconButton testID={`${testID}-copy`} accessibilityLabel={format(dict.itemDetail.copy, label)} onPress={() => { void Clipboard.setStringAsync(value); }}><Icon name="copy" size="lg" color={colors.secondary} /></IconButton>}
      </View>
    </View>
  );
}

export default function ItemDetailScreen({ item, allItems, inTrash, onEdit, onDelete, onRestore, onToggleFavorite, onClose, onSelectRelated, onShare }: {
  item: VaultItem; allItems: VaultItem[]; inTrash: boolean;
  onShare?: () => void; onEdit: () => void; onDelete: () => void; onRestore: () => void; onToggleFavorite: () => void; onClose: () => void; onSelectRelated: (id: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const { colors, styles, theme } = useMobileTheme();
  const { dict, locale } = useTranslation();
  const d = dict.itemDetail;
  const m = dict.mobile;
  const f = item.fields as Record<string, unknown>;
  const displayTitle = item.type === 'card' ? cardIssuer(item.title, f.bank) : item.title;
  const str = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : '');
  const [totp, setTotp] = useState('');
  const [totpLeft, setTotpLeft] = useState(30);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const focused = useIsFocused();
  const [localCode, setLocalCode] = useState('');
  const cardId = item.type === 'card' ? item.id : undefined;
  useEffect(() => {
    setLocalCode('');
    if (!focused || !cardId) return;
    let active = true;
    void readLocalCardCode(cardId).then(
      (code) => { if (active) setLocalCode(code); },
      () => { if (active) setLocalCode(''); },
    );
    return () => { active = false; };
  }, [cardId, focused]);
  useEffect(() => {
    const secret = str('totp_secret'); if (!secret) return;
    const tick = () => { const r = generateTotp(secret); setTotp(r.code); setTotpLeft(r.secondsRemaining); };
    tick(); const id = setInterval(tick, 1000); return () => clearInterval(id);
  }, [item.id]);
  useEffect(() => {
    if (!copiedKey) return;
    const id = setTimeout(() => setCopiedKey(null), 2000);
    return () => clearTimeout(id);
  }, [copiedKey]);
  const related = (item.relations ?? []).map((r) => allItems.find((i) => i.id === r.target_id)).filter((i): i is VaultItem => !!i);
  const archived = isArchived(item);
  const passwordHistory = item.type === 'login' ? getPasswordHistory(item) : [];
  const revisions = item.type === 'secure_note' ? getNoteRevisions(item) : [];
  const parentId = typeof f.parent_id === 'string' ? (f.parent_id as string) : '';
  const parent = parentId ? allItems.find((c) => c.id === parentId) : undefined;
  const children = item.type === 'collection' ? allItems.filter((c) => typeof c.fields?.parent_id === 'string' && c.fields.parent_id === item.id) : [];
  const fieldLabel = (key: string) => (dict.fields as Record<string, string>)[key] ?? key.replace(/_/g, ' ');
  const entries: Array<[string, string, boolean, string]> = []; // [label, value, secret, key]
  const add = (key: string, secret = false, value = str(key)) => { if (value) entries.push([fieldLabel(key), value, secret, key]); };
  if (item.type === 'login' || item.type === 'passkey') ['username', 'password', 'url', 'credential_id', 'rp_id', 'notes'].forEach((k) => add(k, k === 'password'));
  if (item.type === 'bank_account') ['bank_name', 'account_number', 'currency', 'holder_name', 'branch', 'notes'].forEach((k) => add(k, k === 'account_number'));
  if (item.type === 'card') {
    const kind = str('card_type');
    add('brand', false, str('brand') === 'other' ? dict.card.otherBrand : str('brand'));
    add('card_type', false, kind === 'credit' || kind === 'debit' ? dict.card[kind] : kind);
    add('cardholder');
    if (!str('card_number')) add('last4');
    else if (focused) add('card_number', true);
    add('expiry');
    if (focused) add('cvv', true, localCode);
    if (kind === 'credit') {
      add('credit_limit');
      add('statement_day');
    }
    add('notes');
  }
  if (item.type === 'identity') ['full_name', 'document_number', 'issued_date', 'expiry_date', 'notes'].forEach((k) => add(k, k === 'document_number'));
  if (item.type === 'ssh_key') ['public_key', 'private_key_ref', 'comment', 'notes'].forEach((k) => add(k, k === 'private_key_ref'));
  if (item.type === 'api_key') ['service', 'key', 'scopes', 'expires_at', 'notes'].forEach((k) => add(k, k === 'key'));
  if (item.type === 'secure_note') add('body');
  if (item.type === 'document' || item.type === 'media') { ['blob_id', 'mime_type'].forEach((k) => add(k)); if (item.type === 'media') ['width', 'height', 'duration_s'].forEach((k) => add(k)); add('notes'); }
  if (item.type === 'collection' || item.type === 'custom') { add('description'); for (const [k, v] of Object.entries(f)) if (typeof v === 'string' && v && k !== 'description') entries.push([k, v, k === 'card_number', k]); }
  const secretKey = SECRET_KEYS.find((k) => str(k));
  const copySecret = () => { if (!secretKey) return; void Clipboard.setStringAsync(str(secretKey)); setCopiedKey(secretKey); };
  const when = (iso: string) => formatDate(locale, new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const confirmTrash = () => Alert.alert(m.moveToTrashTitle, m.moveToTrashBody, [{ text: dict.common.cancel, style: 'cancel' }, { text: dict.shell.bulkMoveToTrash, style: 'destructive', onPress: onDelete }]);
  const confirmForever = () => Alert.alert(m.deleteForeverTitle, m.deleteForeverBody, [{ text: dict.common.cancel, style: 'cancel' }, { text: dict.common.delete, style: 'destructive', onPress: onDelete }]);
  const card = { backgroundColor: colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 14 } as const;
  const sheetAction = (testID: string, label: string, onPress: () => void, tone?: 'danger') => (
    <Pressable key={testID} testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={() => { setMenuOpen(false); onPress(); }} style={{ minHeight: 52, justifyContent: 'center', paddingHorizontal: 16 }}>
      <Text style={{ color: tone === 'danger' ? colors.dangerText : colors.text, fontSize: 16, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView style={{ flex: 1 }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 20, paddingBottom: 32, width: '100%', maxWidth: 720, alignSelf: 'center' }}>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 4 }}>
          <TypeModule type={item.type} theme={theme} size={56} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.heading, { fontSize: 22, lineHeight: 28 }]}>{displayTitle}</Text>
            <Text style={{ color: colors.muted, fontSize: 14, marginTop: 4 }}>{typeLabel(dict, item.type)}{item.favorite ? `  · ${d.favorite}` : ''}{inTrash ? `  · ${d.inTrash}` : ''}{archived ? `  · ${d.archived}` : ''}</Text>
          </View>
        </View>
        {parent ? (
          <Pressable testID="detail-parent" accessibilityLabel={`${d.inCollection}: ${parent.title}`} onPress={() => onSelectRelated(parent.id)} style={{ marginTop: 8 }}>
            <Text style={{ color: colors.link, fontSize: 14, textDecorationLine: 'underline' }}>{d.inCollection}: {parent.title}</Text>
          </Pressable>
        ) : null}
        {str('totp_secret') ? (
          <View style={[card, { padding: 16, marginTop: 16, flexDirection: 'row', alignItems: 'center', gap: 14 }]}>
            <Ring value={(totpLeft / 30) * 100} color={totpLeft <= 5 ? colors.danger : colors.ok} track={colors.cardBorder} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.muted, fontSize: 13 }}>{d.totp}</Text>
              <Text testID="totp-code" accessibilityLabel={`${d.totp} ${totp}`} style={{ color: colors.text, fontSize: 26, fontWeight: '700', letterSpacing: 3 }}>{totp ? (totp.length === 6 ? `${totp.slice(0, 3)} ${totp.slice(3)}` : totp) : d.totpInvalid}</Text>
              <Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>{plural(locale, d.totpRefresh, totpLeft)}</Text>
            </View>
            <IconButton testID="totp-copy" accessibilityLabel={d.copyCode} style={{ borderWidth: 1, borderColor: colors.cardBorder }} onPress={() => { void Clipboard.setStringAsync(totp); }}>
              <Icon name="copy" size="lg" color={colors.secondary} />
            </IconButton>
          </View>
        ) : null}
        <View style={[card, { marginTop: 16, overflow: 'hidden' }]}>
          {entries.map(([label, value, secret, key], i) =>
            item.type === 'secure_note' && key === 'body' ? (
              <View key={key} style={{ padding: 16 }}>
                <Text style={{ color: colors.muted, fontSize: 13, marginBottom: 6 }}>{label}</Text>
                <MarkdownText source={value} />
              </View>
            ) : (
              <View key={key} style={i === 0 ? { marginTop: -1 } : undefined}>
                <FieldRow label={label} value={value} secret={secret} mask={key === 'card_number' ? `•••• ${cardLast4(f)}` : undefined} copyable={key !== 'cvv'} testID={`field-${key}`} />
              </View>
            ),
          )}
          {entries.length === 0 ? <Text style={{ color: colors.muted, padding: 16 }}>{d.noFields}</Text> : null}
        </View>
        {passwordHistory.length > 0 ? (
          <View style={{ marginTop: 20 }}>
            <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 6 }}>{d.previousPasswords}</Text>
            <Text style={{ color: colors.muted, fontSize: 13, marginBottom: 10 }}>{d.previousPasswordsHint}</Text>
            <View style={[card, { overflow: 'hidden' }]}>
              {passwordHistory.map((entry, i) => (
                <FieldRow key={i} label={format(d.changedAt, when(entry.changed_at))} value={entry.password} secret testID={`history-${i}`} />
              ))}
            </View>
          </View>
        ) : null}
        {revisions.length > 0 ? (
          <View style={{ marginTop: 20 }}>
            <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 6 }}>{d.revisions}</Text>
            <Text style={{ color: colors.muted, fontSize: 13, marginBottom: 10 }}>{m.revisionsHint}</Text>
            {revisions.map((rev, i) => (
              <View key={i} style={[card, { padding: 14, marginBottom: 8 }]}>
                <Text style={{ color: colors.muted, fontSize: 12 }}>{format(d.savedAt, when(rev.saved_at))}</Text>
                <Text style={{ color: colors.text, fontSize: 14, lineHeight: 19, marginTop: 6 }} numberOfLines={4}>{rev.body}</Text>
                <Pressable testID={`revision-copy-${i}`} accessibilityLabel={m.copyVersion} style={[styles.ghostButton, { marginTop: 8 }]} onPress={() => { void Clipboard.setStringAsync(rev.body); }}>
                  <Text style={styles.ghostButtonText}>{m.copyVersion}</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
        {children.length > 0 ? (
          <View style={{ marginTop: 20 }}>
            <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 8 }}>{d.inside}</Text>
            {children.map((child) => (
              <Pressable key={child.id} testID={`child-${child.id}`} accessibilityLabel={child.title} onPress={() => onSelectRelated(child.id)} style={[card, { padding: 14, marginBottom: 8 }]}>
                <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>{child.title}</Text>
                <Text style={{ color: colors.muted, fontSize: 13 }}>{typeLabel(dict, child.type)}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {(item.tags ?? []).length > 0 && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 16 }}>{item.tags.map((t) => (<View key={t} style={styles.chip}><Text style={styles.chipText}>#{t}</Text></View>))}</View>
        )}
        {related.length > 0 && (
          <View style={{ marginTop: 20 }}>
            <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 8 }}>{d.relations}</Text>
            {related.map((r) => (
              <Pressable key={r.id} testID={`related-${r.id}`} accessibilityLabel={r.title} onPress={() => onSelectRelated(r.id)} style={[card, { padding: 14, marginBottom: 8 }]}>
                <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>{r.title}</Text>
                <Text style={{ color: colors.muted, fontSize: 13 }}>{typeLabel(dict, r.type)}</Text>
              </Pressable>
            ))}
          </View>
        )}
        <Text style={{ color: colors.muted, fontSize: 12, marginTop: 16 }}>{format(d.created, when(item.created_at))} · {format(d.updated, when(item.updated_at))}</Text>
      </ScrollView>

      {/* Primary actions stay within thumb reach. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 10, paddingBottom: Math.max(insets.bottom, 12), backgroundColor: colors.bg, borderTopColor: colors.cardBorder, borderTopWidth: 1 }}>
        {inTrash ? (
          <Pressable testID="detail-restore" accessibilityRole="button" accessibilityLabel={d.restore} style={[styles.primaryButton, { flex: 1 }]} onPress={onRestore}><Text style={styles.primaryButtonText}>{d.restore}</Text></Pressable>
        ) : (
          <Pressable testID="detail-copy-secret" accessibilityRole="button" accessibilityLabel={secretKey ? format(d.copy, fieldLabel(secretKey)) : d.copyPassword} accessibilityState={{ disabled: !secretKey }} disabled={!secretKey} style={[styles.primaryButton, { flex: 1, opacity: secretKey ? 1 : 0.5 }]} onPress={copySecret}>
            <Icon name="copy" size="lg" color={colors.onAccent} />
            <Text style={[styles.primaryButtonText, { flexShrink: 1, textAlign: 'center' }]}>{copiedKey ? dict.common.copied : secretKey === 'password' || !secretKey ? d.copyPassword : format(d.copy, fieldLabel(secretKey))}</Text>
          </Pressable>
        )}
        {!inTrash && onShare && !['media', 'document', 'collection'].includes(item.type) && <IconButton testID="detail-share" accessibilityLabel={dict.mobileUI.share} onPress={onShare} style={[styles.ghostButton, { width: 50, height: 50, paddingHorizontal: 0 }]}><Icon name="share" size="lg" color={colors.text} /></IconButton>}
        <IconButton testID="detail-more" accessibilityLabel={d.more} onPress={() => setMenuOpen(true)} style={[styles.ghostButton, { width: 50, height: 50, paddingHorizontal: 0 }]}>
          <Icon name="more" size="lg" color={colors.text} />
        </IconButton>
      </View>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable accessibilityLabel={dict.common.close} onPress={() => setMenuOpen(false)} style={{ flex: 1, backgroundColor: 'rgba(30,34,39,0.28)', justifyContent: 'flex-end' }}>
          <ScreenFrame style={{ flex: 0 }}>
            <View accessibilityViewIsModal style={{ backgroundColor: colors.card, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingVertical: 8, margin: 0 }}>
              {!inTrash ? sheetAction('detail-edit', d.edit, onEdit) : null}
              {sheetAction('detail-favorite', item.favorite ? d.unfavoriteAction : d.favoriteAction, onToggleFavorite)}
              {inTrash
                ? sheetAction('detail-delete-permanent', dict.shell.bulkDeleteForever, confirmForever, 'danger')
                : sheetAction('detail-delete', dict.shell.bulkMoveToTrash, confirmTrash, 'danger')}
              {sheetAction('detail-menu-close', dict.common.cancel, () => undefined)}
            </View>
          </ScreenFrame>
        </Pressable>
      </Modal>
    </View>
  );
}
