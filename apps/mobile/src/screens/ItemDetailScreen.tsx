import React, { useEffect, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import { cardIssuer, cardLast4, formatCardNumber } from '../../../../packages/core/src/card';
import type { VaultItem } from '../../../../packages/core/src/types';
import { format, formatDate, type Dictionary, type Locale } from '../../../../packages/i18n/src/index';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { Icon } from '../../../../packages/ui/src/native';
import { moduleIcon } from '../../../../packages/ui/src/modules';
import { typeLabel } from '../components/ItemRow';
import MarkdownText from '../components/MarkdownText';
import {
  AppButton, AppPage, BottomSheet, Group, IconButton, InlineError, Progress, Rule, SettingsRow,
} from '../components/mobile-ui';
import { useMobileTheme } from '../theme';
import { radius, size, space, textStyle } from '../ui/tokens';
import { detailString, formatDetailFieldsForClipboard, getPrimaryDetailAction, type DetailCopyKey } from '../utils/detailAction';
import { normalizeCardExpiry, readCustomFields } from '../utils/itemEditor';
import { getNoteRevisions, getPasswordHistory, isArchived } from '../utils/itemMeta';
import { generateTotp, type TotpResult } from '../utils/totp';
import { readLocalCardCode } from '../vault';

interface DisplayField {
  key: string;
  label: string;
  value: string;
  display?: string;
  secret?: boolean;
  mask?: string;
  includeInCopyAll?: boolean;
}

const FIELD_ORDER: Record<VaultItem['type'], readonly string[]> = {
  login: ['username', 'password', 'url', 'notes'],
  passkey: ['rp_id', 'credential_id', 'public_key', 'notes'],
  bank_account: ['bank_name', 'holder_name', 'account_number', 'currency', 'branch', 'notes'],
  card: ['brand', 'card_type', 'cardholder', 'card_number', 'expiry', 'notes'],
  identity: ['full_name', 'document_type', 'document_number', 'issued_date', 'expiry_date', 'notes'],
  ssh_key: ['public_key', 'private_key_ref', 'private_key', 'comment', 'notes'],
  api_key: ['service', 'key', 'scopes', 'expires_at', 'notes'],
  secure_note: ['body', 'checklist', 'notes'],
  document: ['file_name', 'mime_type', 'notes'],
  media: ['file_name', 'mime_type', 'width', 'height', 'duration_s', 'notes'],
  collection: ['description', 'url', 'notes'],
  custom: ['description', 'notes'],
};

const SENSITIVE_FIELDS = new Set(['password', 'account_number', 'document_number', 'card_number', 'private_key', 'private_key_ref', 'key']);
const DATE_FIELDS = new Set(['issued_date', 'expiry_date', 'expires_at']);
const COPY_ALL = Symbol('copy-all');

function valueAsText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return Array.isArray(value) && value.every((part) => typeof part === 'string') ? value.join('\n') : '';
}

function dateDisplay(locale: Locale, value: string, time = false): string {
  // A calendar date is shown as saved even in time zones west of UTC.
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDate(locale, date, { dateStyle: 'medium', timeStyle: time ? 'short' : undefined });
}

function detailFields(item: VaultItem, dict: Dictionary, locale: Locale, localCode: string): DisplayField[] {
  const fields = item.fields;
  const keys = [...FIELD_ORDER[item.type]];
  const last4 = cardLast4(fields);
  if (item.type === 'card') {
    if (!detailString(item, 'card_number') && /^\d{4}$/.test(last4)) keys.splice(keys.indexOf('card_number'), 1, 'last4');
    if (localCode) keys.splice(keys.indexOf('expiry') + 1, 0, 'cvv');
    if (fields.card_type === 'credit') keys.splice(keys.indexOf('notes'), 0, 'credit_limit', 'statement_day');
  }
  const known: DisplayField[] = [];
  for (const key of keys) {
    const value = key === 'cvv' ? localCode : valueAsText(fields[key]);
    if (!value) continue;
    const label = (dict.fields as Record<string, string>)[key] ?? key;
    let display: string | undefined;
    if (DATE_FIELDS.has(key)) display = dateDisplay(locale, value);
    if (key === 'card_number') display = formatCardNumber(value, detailString(item, 'brand') || undefined);
    if (key === 'expiry') display = normalizeCardExpiry(value);
    if (key === 'brand' && value === 'other') display = dict.card.otherBrand;
    if (key === 'card_type' && (value === 'debit' || value === 'credit')) display = dict.card[value];
    known.push({
      key, label, value, display,
      secret: SENSITIVE_FIELDS.has(key) || key === 'cvv',
      mask: key === 'card_number' && /^\d{4}$/.test(last4) ? `•••• ${last4}` : undefined,
      includeInCopyAll: key !== 'cvv',
    });
  }
  const custom = readCustomFields(item)
    .map(({ key, label, value, kind }): DisplayField => ({
      key, label, value: valueAsText(value),
      secret: kind === 'secret' || SENSITIVE_FIELDS.has(key),
      display: kind === 'date' && typeof value === 'string' ? dateDisplay(locale, value) : undefined,
    }))
    .filter((field) => field.value);
  return known.concat(custom);
}

function FieldRow({ field, canReveal, copied, onCopy, testID }: {
  field: DisplayField;
  canReveal: boolean;
  copied: boolean;
  onCopy: () => void;
  testID: string;
}) {
  const { dict: { itemDetail: d, common } } = useTranslation();
  const { styles } = useMobileTheme();
  const [revealed, setRevealed] = useState(false);
  useEffect(() => { if (!canReveal) setRevealed(false); }, [canReveal]);
  const showing = revealed && canReveal;
  const { label, value, display, mask = '••••••••', secret } = field;
  return (
    <View style={local.field}>
      <Text style={styles.small}>{label}</Text>
      <View style={local.valueRow}>
        <Text selectable={!secret || showing} style={[styles.body, local.fill]}>
          {secret && !showing ? mask : display ?? value}
        </Text>
        {secret && <IconButton testID={`${testID}-toggle`} icon={showing ? 'hide' : 'show'}
          accessibilityLabel={format(showing ? d.hide : d.show, label)} accessibilityState={{ selected: showing }}
          disabled={!canReveal} onPress={() => setRevealed((current) => !current)} />}
        <IconButton testID={`${testID}-copy`} icon={copied ? 'check' : 'copy'}
          accessibilityLabel={copied ? common.copied : format(d.copy, label)} disabled={!canReveal} onPress={onCopy} />
      </View>
    </View>
  );
}

export default function ItemDetailScreen({ item, allItems, inTrash, onEdit, onDelete, onRestore, onToggleFavorite, onSelectRelated, onShare, onOpenCollection, onOpenFile }: {
  item: VaultItem;
  allItems: VaultItem[];
  inTrash: boolean;
  onEdit: () => void;
  onDelete: () => void | Promise<void>;
  onRestore: () => void | Promise<void>;
  onToggleFavorite: () => void;
  onClose?: () => void;
  onSelectRelated: (id: string) => void;
  onShare?: () => void;
  onOpenCollection?: () => void;
  onOpenFile?: () => void;
}) {
  const { colors, styles } = useMobileTheme();
  const { dict, locale, tp } = useTranslation();
  const { itemDetail: d, mobile: m, mobileDetail: detail } = dict;
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === 'active' || AppState.currentState === null);
  const [menu, setMenu] = useState<'actions' | 'delete' | null>(null);
  const [localCode, setLocalCode] = useState<{ cardId: string; value: string } | null>(null);
  const [localCodeFailure, setLocalCodeFailure] = useState<string>();
  const [totpState, setTotpState] = useState<{ secret: string; value: TotpResult } | null>(null);
  const [copied, setCopied] = useState<string | typeof COPY_ALL | null>(null);
  const [pending, setPending] = useState<'restore' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const visible = foreground && focused;
  const canReveal = visible && !menu;
  const cardId = item.type === 'card' ? item.id : undefined;
  const totpSecret = item.type === 'login' ? detailString(item, 'totp_secret') : '';
  const totp = totpState?.secret === totpSecret ? totpState.value : null;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    setLocalCode(null);
    setLocalCodeFailure(undefined);
    if (!visible || !cardId) return;
    let active = true;
    void readLocalCardCode(cardId).then(
      (value) => { if (active && value) setLocalCode({ cardId, value }); },
      () => { if (active) setLocalCodeFailure(cardId); },
    );
    return () => { active = false; };
  }, [cardId, visible, item.updated_at]);
  useEffect(() => {
    setTotpState(null);
    if (!visible || !totpSecret) return;
    const tick = () => setTotpState({ secret: totpSecret, value: generateTotp(totpSecret) });
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [totpSecret, visible]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const displayTitle = item.type === 'card' ? cardIssuer(item.title, item.fields.bank) : item.title;
  const type = typeLabel(dict, item.type);
  const subtitle = [type, item.favorite && d.favorite, inTrash && d.inTrash, isArchived(item) && d.archived].filter(Boolean).join(' · ');
  const related = item.relations.map((relation) => allItems.find((entry) => entry.id === relation.target_id)).filter((entry): entry is VaultItem => !!entry);
  const parent = allItems.find((entry) => entry.id === item.fields.parent_id && entry.id !== item.id);
  const children = item.type === 'collection' ? allItems.filter((entry) => entry.fields.parent_id === item.id && entry.id !== item.id) : [];
  const history = item.type === 'login' ? getPasswordHistory(item) : [];
  const revisions = item.type === 'secure_note' ? getNoteRevisions(item) : [];
  const entries = detailFields(item, dict, locale, visible && localCode?.cardId === cardId ? localCode?.value ?? '' : '');

  async function copy(key: string | typeof COPY_ALL, value: string) {
    if (!value || !visible) return;
    setError('');
    try {
      if (!await Clipboard.setStringAsync(value)) throw new Error('Clipboard unavailable');
      setCopied(key);
    } catch {
      setError(dict.mobileUI.clipboardFailed);
    }
  }

  async function update(kind: 'restore' | 'delete') {
    if (pending) return;
    setPending(kind);
    setError('');
    try {
      await (kind === 'restore' ? onRestore() : onDelete());
    } catch {
      setError(detail.actionFailed);
    } finally {
      setPending(null);
    }
  }

  const action = getPrimaryDetailAction(item, { inTrash, canOpenCollection: !!onOpenCollection, canOpenFile: !!onOpenFile });
  const copyLabels: Record<DetailCopyKey, string> = {
    password: d.copyPassword,
    username: d.copyUsername,
    account_number: detail.copyAccountNumber,
    last4: detail.copyCardLast4,
    document_number: detail.copyDocumentNumber,
    key: detail.copyApiKey,
    body: detail.copyNote,
    public_key: detail.copyPublicKey,
    private_key_ref: detail.copyPrivateKeyRef,
  };
  let primary: React.ReactNode;
  switch (action.type) {
    case 'restore':
      primary = <AppButton label={d.restore} icon="restore" testID="detail-restore" loading={pending === 'restore'}
        disabled={pending === 'delete'} onPress={() => void update('restore')} style={local.fill} />;
      break;
    case 'copy':
      primary = <AppButton label={copied === action.key ? dict.common.copied : copyLabels[action.key]}
        icon={copied === action.key ? 'check' : 'copy'} testID="detail-copy-secret"
        disabled={!!pending} onPress={() => void copy(action.key, action.value)} style={local.fill} />;
      break;
    case 'openCollection':
      primary = <AppButton label={detail.openCollection} icon="collections" testID="detail-open-collection"
        disabled={!!pending} onPress={() => onOpenCollection?.()} style={local.fill} />;
      break;
    case 'openFile':
      primary = <AppButton label={dict.mobileUI.openFile} icon="file" testID="detail-open-file"
        disabled={!!pending} onPress={() => onOpenFile?.()} style={local.fill} />;
      break;
    case 'edit':
      primary = <AppButton label={d.edit} icon="edit" testID="detail-edit-primary"
        disabled={!!pending} onPress={onEdit} style={local.fill} />;
      break;
  }

  const canShare = !inTrash && onShare && item.type !== 'media' && item.type !== 'document' && item.type !== 'collection';
  const footer = (
    <View style={local.noticeStack}>
      {!!error && <InlineError testID="detail-action-error">{error}</InlineError>}
      <View style={local.actions}>
        {primary}
        {!!canShare && <IconButton testID="detail-share" icon="share" accessibilityLabel={dict.mobileUI.share} disabled={!!pending} onPress={onShare} />}
        <IconButton testID="detail-more" icon="more" accessibilityLabel={d.more} disabled={!!pending} onPress={() => setMenu('actions')} />
      </View>
    </View>
  );

  return (
    <AppPage safeArea="bottom" footer={footer}>
      <View style={local.heading}>
        <View style={[local.headingGlyph, { backgroundColor: colors.surfaceMuted }]}>
          <Icon name={moduleIcon[item.type]} color={colors.secondaryText} size="xl" />
        </View>
        <View style={local.fill}>
          <Text accessibilityRole="header" style={styles.heading}>{displayTitle}</Text>
          <Text style={styles.small}>{subtitle}</Text>
        </View>
      </View>

      {parent && (
        <Group>
          <SettingsRow testID="detail-parent" label={parent.title} detail={d.inCollection}
            icon="collections" navigation onPress={() => onSelectRelated(parent.id)} />
        </Group>
      )}

      {totpSecret && visible ? (
        <Group title={d.totp}>
          <View style={local.field}>
            <View style={local.valueRow}>
              <Text testID="totp-code" style={[textStyle.title, local.fill, { color: colors.text, fontVariant: ['tabular-nums'] }]}>
                {totp?.code ? `${totp.code.slice(0, 3)} ${totp.code.slice(3)}` : totp ? d.totpInvalid : d.totpLoading}
              </Text>
              {!!totp?.code && <IconButton testID="totp-copy" icon={copied === 'totp' ? 'check' : 'copy'}
                accessibilityLabel={copied === 'totp' ? dict.common.copied : d.copyCode}
                onPress={() => void copy('totp', generateTotp(totpSecret).code)} />}
            </View>
            {!!totp?.code && <Progress value={totp.secondsRemaining / totp.period} label={tp(d.totpRefresh, totp.secondsRemaining)} />}
          </View>
        </Group>
      ) : null}

      <Group title={d.fields}>
        {entries.some(({ includeInCopyAll }) => includeInCopyAll !== false) && (
          <>
            <SettingsRow testID="detail-copy-all" label={copied === COPY_ALL ? dict.common.copied : detail.copyAll}
              icon={copied === COPY_ALL ? 'check' : 'copy'} disabled={!canReveal || !!pending}
              onPress={() => void copy(COPY_ALL, formatDetailFieldsForClipboard(entries))} />
            <Rule />
          </>
        )}
        {entries.length === 0 && <Text style={[styles.small, local.field]}>{d.noFields}</Text>}
        {entries.map((field, index) => (
          <React.Fragment key={`${item.id}-${field.key}`}>
            {index > 0 && <Rule />}
            {item.type === 'secure_note' && field.key === 'body' ? (
              <View style={local.field}><MarkdownText source={field.value} /></View>
            ) : (
              <FieldRow field={field} canReveal={canReveal} copied={copied === field.key}
                testID={`field-${field.key}`} onCopy={() => void copy(field.key, field.value)} />
            )}
          </React.Fragment>
        ))}
        {localCodeFailure !== undefined && localCodeFailure === cardId && visible && (
          <View style={local.field}><InlineError testID="detail-card-code-error">{dict.card.codeReadFailed}</InlineError></View>
        )}
      </Group>

      {history.length > 0 && (
        <Group title={d.previousPasswords} footer={d.previousPasswordsHint}>
          {history.map((entry, index) => {
            const key = `history-${index}`;
            return (
              <React.Fragment key={`${item.id}-${key}`}>
                {index > 0 && <Rule />}
                <FieldRow field={{ key, label: format(d.changedAt, dateDisplay(locale, entry.changed_at, true)), value: entry.password, secret: true }}
                  testID={key} canReveal={canReveal} copied={copied === key} onCopy={() => void copy(key, entry.password)} />
              </React.Fragment>
            );
          })}
        </Group>
      )}

      {revisions.length > 0 && (
        <Group title={d.revisions} footer={m.revisionsHint}>
          {revisions.map((entry, index) => (
            <React.Fragment key={index}>
              {index > 0 && <Rule />}
              <View style={local.field}>
                <Text style={styles.small}>{format(d.savedAt, dateDisplay(locale, entry.saved_at, true))}</Text>
                <Text style={styles.body} numberOfLines={4}>{entry.body}</Text>
                <AppButton label={copied === `revision-${index}` ? dict.common.copied : m.copyVersion} icon="copy"
                  variant="secondary" size="compact" testID={`revision-copy-${index}`}
                  onPress={() => void copy(`revision-${index}`, entry.body)} />
              </View>
            </React.Fragment>
          ))}
        </Group>
      )}

      {children.length > 0 && (
        <Group title={d.inside}>
          {children.map((entry, index) => (
            <React.Fragment key={entry.id}>
              {index > 0 && <Rule leading />}
              <SettingsRow testID={`child-${entry.id}`} label={entry.title} detail={typeLabel(dict, entry.type)}
                icon={moduleIcon[entry.type]} navigation onPress={() => onSelectRelated(entry.id)} />
            </React.Fragment>
          ))}
        </Group>
      )}

      {item.tags.length > 0 && (
        <View style={local.tagSection}>
          <Text style={styles.label}>{d.tags}</Text>
          <View style={local.tags}>
            {item.tags.map((tag) => (
              <Text key={tag} style={[styles.chipText, local.tag, { color: colors.secondaryText, backgroundColor: colors.surfaceMuted }]}>{tag}</Text>
            ))}
          </View>
        </View>
      )}

      {related.length > 0 && (
        <Group title={d.relations}>
          {related.map((entry, index) => (
            <React.Fragment key={entry.id}>
              {index > 0 && <Rule leading />}
              <SettingsRow testID={`related-${entry.id}`} label={entry.title} detail={typeLabel(dict, entry.type)}
                icon={moduleIcon[entry.type]} navigation onPress={() => onSelectRelated(entry.id)} />
            </React.Fragment>
          ))}
        </Group>
      )}

      <View style={local.timestamp}>
        <Text style={styles.small}>{format(d.created, dateDisplay(locale, item.created_at, true))}</Text>
        <Text style={styles.small}>{format(d.updated, dateDisplay(locale, item.updated_at, true))}</Text>
      </View>

      <BottomSheet visible={menu !== null} title={menu === 'delete' ? (inTrash ? m.deleteForeverTitle : m.moveToTrashTitle) : d.more}
        testID="detail-menu" onClose={() => setMenu(null)}>
        {menu === 'delete' ? (
          <View style={local.confirmation}>
            <Text style={styles.body} accessibilityLiveRegion="polite">{inTrash ? m.deleteForeverBody : m.moveToTrashBody}</Text>
            <AppButton testID="detail-delete-confirm" label={inTrash ? dict.shell.bulkDeleteForever : dict.shell.bulkMoveToTrash}
              variant="destructive" icon="trash" onPress={() => { setMenu(null); void update('delete'); }} />
            <AppButton testID="detail-delete-cancel" label={dict.common.cancel} variant="text" onPress={() => setMenu('actions')} />
          </View>
        ) : (
          <Group>
            {!inTrash && (
              <>
                <SettingsRow testID="detail-edit" label={d.edit} icon="edit" onPress={() => { setMenu(null); onEdit(); }} />
                <Rule leading />
                <SettingsRow testID="detail-favorite" label={item.favorite ? d.unfavoriteAction : d.favoriteAction}
                  icon="favorite" onPress={() => { setMenu(null); onToggleFavorite(); }} />
                <Rule leading />
              </>
            )}
            <SettingsRow testID={inTrash ? 'detail-delete-permanent' : 'detail-delete'}
              label={inTrash ? dict.shell.bulkDeleteForever : dict.shell.bulkMoveToTrash} icon="trash" destructive onPress={() => setMenu('delete')} />
          </Group>
        )}
      </BottomSheet>
    </AppPage>
  );
}

const local = StyleSheet.create({
  heading: { flexDirection: 'row', alignItems: 'center', gap: space[3], marginBottom: space[6] },
  headingGlyph: { width: space[12], height: space[12], borderRadius: radius.glyph, alignItems: 'center', justifyContent: 'center' },
  fill: { flex: 1, minWidth: 0 },
  field: { paddingHorizontal: space[4], paddingVertical: space[3], gap: space[1] },
  valueRow: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  noticeStack: { gap: space[2] },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  confirmation: { gap: space[3] },
  tagSection: { marginBottom: space[6] },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  tag: { maxWidth: '100%', borderRadius: radius.full, paddingHorizontal: space[3], paddingVertical: space[1] },
  timestamp: { gap: space[1], paddingTop: space[1] },
});
