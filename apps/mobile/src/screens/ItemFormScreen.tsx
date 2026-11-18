import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, StyleSheet, Text, View, type TextInput, type TextInputProps } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { ItemType, VaultItem } from '../../../../packages/core/src/types';
import { CARD_TYPES, cardBrands, cardIssuer, cardNumberDigits, detectCardBrand, formatCardNumber } from '../../../../packages/core/src/card';
import { isFileEntry } from '../../../../packages/core/src/files';
import { loginServiceNames } from '../../../../packages/core/src/login-services';
import { libsodiumAdapter as crypto } from '../../../../packages/crypto-adapters/src/index';
import { format, type Dictionary } from '../../../../packages/i18n/src/index';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { moduleIcon } from '../../../../packages/ui/src/modules';
import { Icon } from '../../../../packages/ui/src/native';
import { AppTextField, InputControl } from '../components/Field';
import EditorCustomFields from '../components/EditorCustomFields';
import EditorDateField from '../components/EditorDateField';
import MarkdownText from '../components/MarkdownText';
import StrengthMeter from '../components/StrengthMeter';
import {
  AppButton, AppPage, BottomSheet, Dialog, FieldGroup, FilterChip, FormSection, Group, IconButton,
  InlineError, Rule, SegmentedControl, Select, SelectField, SettingsRow, ToggleRow,
} from '../components/mobile-ui';
import { useMobileTheme } from '../theme';
import { size, space } from '../ui/tokens';
import {
  editorDraftSignature, getEditorIssues, incompatibleFieldLabels, normalizeCardExpiry, normalizeWebsite, readCustomFields, readTemplateFields,
  reclassifyDraft, serializeEditorFields, type CustomEditorField, type EditorIssue,
} from '../utils/itemEditor';
import { readLocalCardCode } from '../vault';
import GeneratorScreen from './GeneratorScreen';

const EDITABLE_TYPES: readonly ItemType[] = ['login', 'bank_account', 'card', 'identity', 'secure_note', 'api_key', 'ssh_key', 'passkey', 'custom', 'collection'];
const CURRENCIES = [
  'VND', 'USD', 'EUR', 'GBP', 'JPY', 'KRW', 'SGD', 'AUD', 'CAD', 'CNY', 'HKD', 'INR', 'THB', 'CHF', 'NZD', 'MYR', 'IDR', 'PHP',
  'AED', 'ARS', 'BDT', 'BGN', 'BHD', 'BRL', 'CLP', 'COP', 'CZK', 'DKK', 'EGP', 'HUF', 'ILS', 'ISK', 'KES', 'KWD', 'LKR', 'MAD',
  'MXN', 'NOK', 'OMR', 'PEN', 'PKR', 'PLN', 'QAR', 'RON', 'RSD', 'SAR', 'SEK', 'TRY', 'TWD', 'UAH', 'ZAR',
];

type FieldName = keyof Dictionary['fields'];
type InputField = {
  key: FieldName; secret?: boolean; multiline?: boolean; date?: boolean; keyboard?: TextInputProps['keyboardType'];
  placeholder?: keyof Dictionary['placeholders']; advanced?: boolean;
};

const FIELDS: Record<ItemType, InputField[]> = {
  login: [
    { key: 'url', keyboard: 'url', placeholder: 'url' },
    { key: 'username' },
    { key: 'password', secret: true },
    { key: 'totp_secret', secret: true, placeholder: 'totp', advanced: true },
    { key: 'notes', multiline: true, advanced: true },
  ],
  passkey: [
    { key: 'credential_id' }, { key: 'rp_id', keyboard: 'url', placeholder: 'rpId' }, { key: 'notes', multiline: true, advanced: true },
  ],
  bank_account: [
    { key: 'bank_name' }, { key: 'holder_name' }, { key: 'account_number', secret: true },
    { key: 'currency', advanced: true }, { key: 'branch', advanced: true }, { key: 'notes', multiline: true, advanced: true },
  ],
  card: [
    { key: 'card_number', secret: true, keyboard: 'number-pad' }, { key: 'brand' }, { key: 'card_type' },
    { key: 'cardholder' }, { key: 'expiry', placeholder: 'expiry', keyboard: 'number-pad' },
    { key: 'cvv', secret: true, keyboard: 'number-pad' }, { key: 'credit_limit' }, { key: 'statement_day', keyboard: 'number-pad' },
    { key: 'notes', multiline: true, advanced: true },
  ],
  identity: [
    { key: 'full_name' }, { key: 'document_number', secret: true }, { key: 'issued_date', date: true }, { key: 'expiry_date', date: true },
    { key: 'document_type', advanced: true }, { key: 'notes', multiline: true, advanced: true },
  ],
  ssh_key: [
    { key: 'public_key', multiline: true }, { key: 'private_key_ref', secret: true }, { key: 'comment', advanced: true },
    { key: 'notes', multiline: true, advanced: true },
  ],
  api_key: [
    { key: 'service' }, { key: 'key', secret: true }, { key: 'scopes', placeholder: 'scopes', advanced: true },
    { key: 'expires_at', date: true, advanced: true }, { key: 'notes', multiline: true, advanced: true },
  ],
  secure_note: [{ key: 'body', multiline: true }, { key: 'checklist', multiline: true, advanced: true }],
  document: [{ key: 'notes', multiline: true }],
  media: [{ key: 'notes', multiline: true }],
  collection: [{ key: 'description', multiline: true }],
  custom: [{ key: 'description', multiline: true }],
};

function newId(): string {
  return Array.from(crypto.randomBytes(16), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface Props {
  initial?: VaultItem;
  template?: ItemType;
  allItems: VaultItem[];
  onSave: (item: VaultItem, localCardCode?: string) => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onTypeChange?: (type: ItemType) => void;
}

function expiryInput(value: string): string {
  if (value.includes('/') || value.includes('-')) return value;
  return value.replace(/^(\d{2})(\d{1,2})$/, '$1/$2');
}

export default function ItemFormScreen({ initial, template = 'login', allItems, onSave, onDirtyChange, onTypeChange }: Props) {
  const { colors, styles } = useMobileTheme();
  const { dict, t, tp } = useTranslation();
  const copy = dict.mobileEditor;
  const [type, setType] = useState(initial?.type ?? template);
  const [title, setTitle] = useState(() => initial?.type === 'card' ? cardIssuer(initial.title, initial.fields.bank) : initial?.title ?? '');
  const [fields, setFields] = useState(() => {
    const record = readTemplateFields(initial);
    if (initial?.type === 'card') {
      if (typeof record.expiry === 'string') record.expiry = normalizeCardExpiry(record.expiry) ?? record.expiry;
      if (typeof record.card_number === 'string' && record.brand === detectCardBrand(record.card_number)) delete record.brand;
    }
    return record;
  });
  const [customFields, setCustomFields] = useState<CustomEditorField[]>(() => initial ? readCustomFields(initial) : []);
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [favorite, setFavorite] = useState(initial?.favorite ?? false);
  const [relationIds, setRelationIds] = useState<string[]>((initial?.relations ?? []).map(({ target_id }) => target_id));
  const [more, setMore] = useState(false);
  const [relationsOpen, setRelationsOpen] = useState(false);
  const [relationQuery, setRelationQuery] = useState('');
  const [typeSheet, setTypeSheet] = useState(false);
  const [nextType, setNextType] = useState<ItemType>();
  const [showPreview, setShowPreview] = useState(false);
  const [generate, setGenerate] = useState(false);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<Record<string, EditorIssue>>({});
  const [titleError, setTitleError] = useState('');
  const [loadedCardCode, setLoadedCardCode] = useState('');
  const [localCardCode, setLocalCardCode] = useState<string>();
  const [codeReadFailed, setCodeReadFailed] = useState(false);
  const inputs = useRef<Record<string, TextInput | null>>({});
  const cardId = initial?.type === 'card' ? initial.id : undefined;

  useEffect(() => {
    if (!cardId) return;
    let active = true;
    void readLocalCardCode(cardId).then(
      (value) => { if (active) setLoadedCardCode(value); },
      () => { if (active) setCodeReadFailed(true); },
    );
    return () => { active = false; };
  }, [cardId]);

  const cardCodeEdited = localCardCode !== undefined && (codeReadFailed || localCardCode !== loadedCardCode);
  const signature = editorDraftSignature({ type, title, fields, customFields, tags, relationIds, favorite, cardCodeEdited });
  const baseline = useRef(signature);
  useEffect(() => { onDirtyChange?.(signature !== baseline.current); }, [signature, onDirtyChange]);

  const stringField = (key: string) => typeof fields[key] === 'string' ? fields[key] as string : '';
  const cardBrand = type === 'card' ? stringField('brand') || detectCardBrand(stringField('card_number')) : undefined;
  const localCode = localCardCode ?? loadedCardCode;
  const setF = (key: string, value: string) => {
    setFields((current) => ({ ...current, [key]: value }));
    if (issues[key]) setIssues((current) => Object.fromEntries(Object.entries(current).filter(([field]) => field !== key)));
  };
  const fieldLabel = (key: string) => (dict.fields as Record<string, string>)[key] ?? key;
  const titleLabel = type === 'card' ? dict.card.issuer : dict.itemForm.title;
  const setName = (value: string) => { setTitle(value); setTitleError(''); };
  const selectedTypeName = (kind: ItemType) => kind === 'passkey' ? copy.passkeyReference : dict.itemTypes[kind];
  const labelsFor = (names: string[]) => names.map((name) => {
    if (name === 'revisions') return copy.noteHistory;
    if (name === 'password_history') return copy.passwordHistory;
    return fieldLabel(name);
  }).join(', ');
  const lossesFor = (target: ItemType) => incompatibleFieldLabels(target, type, fields, customFields, initial, !!localCode || codeReadFailed);
  const typeOptions = EDITABLE_TYPES.includes(type) ? EDITABLE_TYPES : [type, ...EDITABLE_TYPES];
  const nextLosses = nextType ? lossesFor(nextType) : [];
  const closeTypeSheet = () => { setTypeSheet(false); setNextType(undefined); };

  function changeType(next: ItemType) {
    const updated = reclassifyDraft(next, type, fields, customFields);
    setFields(updated.fields);
    setCustomFields(updated.custom);
    if (type === 'card') setLocalCardCode('');
    setIssues({});
    setTitleError('');
    setError('');
    setShowPreview(false);
    setType(next);
    onTypeChange?.(next);
    closeTypeSheet();
  }

  async function write(name: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError('');
    Keyboard.dismiss();
    try {
      const now = new Date().toISOString();
      const item: VaultItem = {
        id: initial?.id ?? `item_${newId()}`, type, schema_version: initial?.schema_version ?? 1, title: name,
        fields: serializeEditorFields(type, fields, customFields, initial, now), tags, favorite,
        relations: relationIds.map((id) => initial?.relations?.find(({ target_id }) => target_id === id) ?? { type: 'related_to', target_id: id }),
        attachments: initial?.attachments ?? [], created_at: initial?.created_at ?? now, updated_at: now,
      };
      await onSave(item, type === 'card' ? localCardCode : undefined);
    } catch {
      setError(t('mobileUI.saveFailed'));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  function save() {
    if (inFlight.current) return;
    const name = title.trim() || (type === 'login' ? normalizeWebsite(stringField('url'))?.host.replace(/^www\./i, '') : '');
    if (!name) {
      setTitleError(type === 'card' ? dict.card.issuerRequired : type === 'login' ? dict.itemForm.loginServiceRequired : dict.itemForm.titleRequired);
      inputs.current.title?.focus();
      return;
    }
    const invalid = getEditorIssues(type, fields, localCardCode, initial);
    setIssues(invalid);
    const first = Object.keys(invalid)[0];
    if (first) {
      if (FIELDS[type].some(({ key, advanced }) => key === first && advanced)) setMore(true);
      inputs.current[first]?.focus();
      return;
    }
    const losses = initial?.type === type ? lossesFor(type) : [];
    if (losses.length) {
      Dialog.alert(copy.incompatibleTitle, format(copy.incompatibleBody, labelsFor(losses)), [
        { text: dict.common.cancel, style: 'cancel' },
        { text: copy.removeAndSave, style: 'destructive', onPress: () => void write(name) },
      ]);
      return;
    }
    void write(name);
  }

  function issueMessage(key: FieldName, label: string) {
    const issue = issues[key];
    if (key === 'cvv' && codeReadFailed && localCardCode === undefined) return dict.card.codeReadFailed;
    if (issue === 'required') return format(dict.mobileUI.requiredField, label);
    if (issue === 'url') return copy.enterValidWebsite;
    if (issue === 'totp') return dict.itemForm.totpInvalid;
    if (issue === 'cardNumber') return dict.card.invalidNumber;
    if (issue === 'cvv') return dict.card.invalidCvv;
    if (issue === 'expiry') return copy.cardExpiryError;
    if (issue === 'statementDay') return dict.card.invalidStatementDay;
    if (issue === 'cardType') return dict.card.chooseType;
    return undefined;
  }

  function renderField(field: InputField) {
    const { key } = field;
    const value = key === 'cvv' ? localCode : stringField(key);
    const label = key === 'username' ? t('mobileUI.loginUsername') : fieldLabel(key);
    const testID = `field-${key}`;
    const fieldError = issueMessage(key, label);
    if (field.date) {
      return <EditorDateField key={key} label={label} value={value} testID={testID} error={fieldError} disabled={saving} onChange={(next) => setF(key, next)} />;
    }
    if (key === 'brand') {
      const networks = cardBrands(cardBrand ?? '').map((network) => ({ value: network, label: network === 'other' ? dict.card.otherBrand : network }));
      return <SelectField flush key={key} label={label} value={cardBrand ?? ''} testID={testID} error={fieldError}
        choices={[{ value: '', label: dict.card.chooseBrand }, ...networks]}
        disabled={saving} onChange={(next) => setF(key, next)} />;
    }
    if (key === 'card_type') {
      return <View key={key}>
        <SegmentedControl label={label} value={value} testID={testID} choices={CARD_TYPES.map((kind) => ({ value: kind, label: dict.card[kind] }))}
          disabled={saving} onChange={(next) => setF(key, next)} />
        {fieldError && <InlineError>{fieldError}</InlineError>}
      </View>;
    }
    if (key === 'currency') {
      const choices = [...new Set([...(value ? [value] : []), ...CURRENCIES])]
        .map((code) => ({ value: code, label: code }));
      return <SelectField flush key={key} label={label} value={value} testID={testID} disabled={saving} helper={copy.currencyHint}
        placeholder={copy.chooseCurrency} choices={choices} onChange={(next) => setF(key, next)} />;
    }
    const isCredit = type === 'card' && key === 'credit_limit';
    const helper = key === 'cvv' ? copy.cardCvvHint
      : key === 'card_number' && !value && stringField('last4') ? format(dict.card.existingDigits, stringField('last4'))
      : key === 'private_key_ref' ? copy.sshReferenceHelp
      : key === 'totp_secret' ? copy.twoFactorHelp : undefined;
    const nextKey = key === 'url' && type === 'login' ? 'username'
      : key === 'username' ? 'password' : key === 'bank_name' ? 'holder_name' : key === 'holder_name' ? 'account_number' : undefined;
    return <View key={key} style={local.fieldExtras}>
      <AppTextField flush ref={(input) => { inputs.current[key] = input; }} label={label} testID={testID}
        value={key === 'card_number' ? formatCardNumber(value, cardBrand) : value}
        disabled={saving} error={fieldError} helper={helper} multiline={field.multiline} revealable={field.secret}
        autoComplete="off" autoCorrect={key === 'body' || key === 'notes'} autoCapitalize={field.multiline ? 'sentences' : 'none'}
        returnKeyType={field.multiline ? 'default' : nextKey ? 'next' : 'done'}
        keyboardType={key === 'username' && value.includes('@') ? 'email-address' : field.keyboard}
        style={key === 'body' ? local.note : key === 'account_number' || key === 'card_number' || key === 'public_key' || key === 'key' ? local.mono : undefined}
        placeholder={isCredit ? dict.card.limitPlaceholder : key === 'statement_day' ? dict.card.dayPlaceholder : field.placeholder && dict.placeholders[field.placeholder]}
        maxLength={key === 'cvv' ? 4 : undefined}
        onEndEditing={key === 'url' && type === 'login' ? () => {
          const parsed = normalizeWebsite(value);
          if (!title.trim() && parsed) setName(parsed.host.replace(/^www\./i, ''));
        } : undefined}
        onSubmitEditing={nextKey ? () => inputs.current[nextKey]?.focus() : undefined}
        onChangeText={(next) => {
          if (key === 'cvv') {
            setLocalCardCode(next.replace(/\D/g, ''));
            setIssues(({ cvv: _old, ...current }) => current);
          } else if (key === 'card_number') setF(key, cardNumberDigits(next));
          else setF(key, key === 'expiry' ? expiryInput(next) : next);
        }}
        trailing={key === 'password' ? <IconButton testID="generate-password-button" icon="generate" tone="link" disabled={saving}
          accessibilityLabel={dict.mobileUI.generatePassword} onPress={() => { Keyboard.dismiss(); setGenerate(true); }} />
          : (key === 'key' || key === 'account_number' || key === 'public_key') && !!value &&
          <IconButton icon="copy" testID={`${testID}-copy`} accessibilityLabel={format(dict.itemDetail.copy, label)} disabled={saving}
            onPress={() => { void Clipboard.setStringAsync(value).catch(() => setError(t('mobileUI.clipboardFailed'))); }} />}
      />
      {key === 'password' && !!value && <StrengthMeter password={value} />}
      {key === 'body' && !!value && <>
        <AppButton label={showPreview ? dict.itemForm.hidePreview : dict.itemForm.preview} variant="text"
          testID="preview-markdown-button" icon={showPreview ? 'hide' : 'show'} onPress={() => setShowPreview((open) => !open)} />
        {showPreview && <MarkdownText source={value} />}
      </>}
    </View>;
  }

  const extraFields = FIELDS[type].filter(({ advanced }) => advanced);
  const requiredFields = FIELDS[type].filter(({ advanced, key }) =>
    !advanced && (type !== 'card' || stringField('card_type') === 'credit' || (key !== 'credit_limit' && key !== 'statement_day')));
  const knownTags = more ? [...new Set(allItems.flatMap((item) => item.tags ?? []))].filter((tag) => !tags.includes(tag)) : [];
  const related = relationsOpen ? allItems.filter((item) => item.id !== initial?.id && item.title.toLowerCase().includes(relationQuery.trim().toLowerCase())).slice(0, 60) : [];
  const closureFields = initial && isFileEntry(initial);

  return (
    <AppPage safeArea="bottom" footer={<View style={local.fieldExtras}>
      {!!error && <InlineError testID="form-error">{error}</InlineError>}
      <AppButton label={saving ? dict.itemForm.saving : dict.itemForm.save} testID="save-item-button" loading={saving} onPress={save} />
    </View>}>
      {type === 'passkey' && <FormSection title={copy.passkeyReference} description={copy.passkeyHelp}><View /></FormSection>}
      <FormSection title={type === 'bank_account' ? copy.accountDetails : undefined}>
        <FieldGroup>
          {type === 'login' ?
            <SelectField flush label={dict.itemForm.loginService} value={title} testID="item-title" disabled={saving}
              error={titleError} choices={loginServiceNames(allItems, title).map((name) => ({ value: name, label: name }))}
              createLabel={(name) => format(dict.itemForm.createLoginService, name)}
              placeholder={dict.itemForm.loginServicePlaceholder} onChange={setName} /> :
            <AppTextField flush ref={(input) => { inputs.current.title = input; }} label={titleLabel} value={title}
              testID="item-title" disabled={saving} error={titleError} autoCapitalize="sentences"
              placeholder={type === 'card' ? dict.card.issuerPlaceholder : dict.placeholders.title} onChangeText={setName} />}
          {requiredFields.map(renderField)}
        </FieldGroup>
      </FormSection>

      {type === 'custom' && <EditorCustomFields fields={customFields} newKey={newId} onChange={setCustomFields} disabled={saving} />}
      <Group>
        <SettingsRow label={t('mobileUI.advancedOptions')} testID="item-more-options" expanded={more}
            disabled={saving} onPress={() => setMore((open) => !open)}>
          <View style={more && local.rotate}>
            <Icon name="expand" color={colors.secondaryText} size={size.inlineIcon} />
          </View>
        </SettingsRow>
      </Group>
      {more && <>
        {type === 'login' && <FormSection title={copy.twoFactor}>{renderField(extraFields[0])}</FormSection>}
        {extraFields.some(({ key }) => key !== 'totp_secret') && <FormSection title={copy.optionalDetails}>
          <FieldGroup>{extraFields.filter(({ key }) => key !== 'totp_secret').map(renderField)}</FieldGroup>
        </FormSection>}

        {type === 'collection' && !closureFields && <SelectField label={dict.itemForm.parentAria} testID="item-parent" value={stringField('parent_id')}
          choices={[{ value: '', label: t('mobileUI.noParent') }, ...allItems
            .filter((candidate) => candidate.type === 'collection' && !isFileEntry(candidate) && validParent(candidate, initial?.id, allItems))
            .map(({ id, title }) => ({ value: id, label: title }))]} disabled={saving} onChange={(next) => setF('parent_id', next)} />}

        <FormSection title={dict.itemForm.tags} description={copy.tagsHint}>
          <View style={local.chips}>
            {tags.map((tag) => <FilterChip key={tag} label={tag} selected disabled={saving} onRemove={() => setTags((current) => current.filter((item) => item !== tag))} />)}
          </View>
          <Select label={copy.addTagTitle} testID="item-tags" value="" choices={knownTags.map((tag) => ({ value: tag, label: tag }))}
            createLabel={(tag) => format(copy.addTag, tag)} disabled={saving}
            onChange={(tag) => setTags((current) => current.includes(tag) ? current : [...current, tag])} />
        </FormSection>

        <Group>
          <ToggleRow testID="item-favorite-toggle" label={dict.itemForm.favorite} value={favorite} onChange={setFavorite} disabled={saving} />
          {allItems.some(({ id }) => id !== initial?.id) && <>
            <Rule />
            <SettingsRow label={t('mobileUI.relatedItems')} value={tp(dict.mobileVault.itemCount, relationIds.length)} testID="item-relations" navigation disabled={saving}
              onPress={() => { setRelationQuery(''); setRelationsOpen(true); }} />
          </>}
          {!closureFields && <>
            <Rule />
            <SettingsRow label={copy.changeType} value={selectedTypeName(type)} testID="item-type" navigation disabled={saving} onPress={() => setTypeSheet(true)} />
          </>}
        </Group>
        {type !== 'custom' && <EditorCustomFields fields={customFields} newKey={newId} onChange={setCustomFields} disabled={saving} />}
      </>}
      {typeSheet && <BottomSheet title={nextType ? copy.changeTypeTitle : copy.changeType} visible testID="item-type-sheet" onClose={closeTypeSheet}
        footer={nextType && <AppButton label={copy.confirmChange} testID="confirm-item-type" variant="destructive" onPress={() => changeType(nextType)} />}>
        {nextType ? <Text style={styles.body}>{format(copy.changeTypeBody, labelsFor(nextLosses))}</Text>
          : typeOptions.map((option) => <SettingsRow key={option} label={selectedTypeName(option)} icon={moduleIcon[option]}
            testID={`item-type-${option}`} accessibilityRole="radio" accessibilityState={{ checked: option === type }} selected={option === type}
            onPress={() => {
              if (option === type) closeTypeSheet();
              else if (lossesFor(option).length) setNextType(option);
              else changeType(option);
            }} />)}
      </BottomSheet>}

      {relationsOpen && <BottomSheet title={t('mobileUI.relatedItems')} visible testID="item-relations-sheet" onClose={() => setRelationsOpen(false)}>
        <InputControl accessibilityLabel={copy.findRelated} placeholder={copy.findRelated} testID="relation-search" value={relationQuery}
          autoCapitalize="none" autoCorrect={false} onChangeText={setRelationQuery} />
        {related.map(({ id, title }) => {
          const checked = relationIds.includes(id);
          return <SettingsRow key={id} label={title} testID={`relation-${id}`} selected={checked} accessibilityRole="checkbox" accessibilityState={{ checked }}
            onPress={() => setRelationIds((current) => checked ? current.filter((candidate) => candidate !== id) : [...current, id])} />;
        })}
      </BottomSheet>}

      {generate && <BottomSheet title={dict.shell.tabs.generator} visible testID="editor-generator" onClose={() => setGenerate(false)}>
        <GeneratorScreen embedded onApply={(password) => { setF('password', password); setGenerate(false); }} />
      </BottomSheet>}
    </AppPage>
  );
}

function validParent(candidate: VaultItem, editingId: string | undefined, allItems: VaultItem[]): boolean {
  if (!editingId) return true;
  const seen = new Set<string>();
  let cursor: VaultItem | undefined = candidate;
  while (cursor) {
    if (cursor.id === editingId || seen.has(cursor.id)) return false;
    seen.add(cursor.id);
    const parent: unknown = cursor.fields.parent_id;
    cursor = typeof parent === 'string' ? allItems.find(({ id }) => id === parent) : undefined;
  }
  return true;
}

const local = StyleSheet.create({
  fieldExtras: { gap: space[2] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2], marginBottom: space[3] },
  note: { minHeight: space[12] * 5 },
  mono: { fontFamily: 'monospace' },
  rotate: { transform: [{ rotate: '180deg' }] },
});
