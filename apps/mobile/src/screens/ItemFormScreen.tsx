import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, Text, View, type TextInput } from 'react-native';
import { useNavigation, type ParamListBase } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { ItemType, VaultItem } from '../../../../packages/core/src/types';
import { CARD_TYPES, cardBrands, cardInputError, cardIssuer, isCardVerificationField, prepareCardFields } from '../../../../packages/core/src/card';
import { loginServiceNames } from '../../../../packages/core/src/login-services';
import Field from '../components/Field';
import StrengthMeter from '../components/StrengthMeter';
import MarkdownText from '../components/MarkdownText';
import { useMobileTheme } from '../theme';
import { Icon } from '../../../../packages/ui/src/native';
import { moduleIcon } from '../../../../packages/ui/src/modules';
import { format, type Dictionary } from '../../../../packages/i18n/src/index';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { Action, Group, IconButton, Page, Row, Rule, Select, ToggleRow } from '../components/mobile-ui';
import { libsodiumAdapter as crypto } from '../../../../packages/crypto-adapters/src/index';
import { generatePassword } from '../utils/password';
import { getPasswordHistory, appendPasswordHistory, getNoteRevisions, appendNoteRevision } from '../utils/itemMeta';
import { readLocalCardCode } from '../vault';

// Files and folders have their own creation flow in the Files tab.
const CREATABLE_TYPES: ItemType[] = [
  'login', 'secure_note', 'card', 'identity', 'bank_account',
  'passkey', 'api_key', 'ssh_key', 'custom',
];

interface ItemField {
  key: keyof Dictionary['fields'];
  secret?: boolean;
  multiline?: boolean;
  placeholder?: keyof Dictionary['placeholders'];
  advanced?: boolean;
}

const FIELDS: Record<ItemType, ItemField[]> = {
  login: [
    { key: 'username' },
    { key: 'password', secret: true },
    { key: 'url', placeholder: 'url' },
    { key: 'totp_secret', secret: true, placeholder: 'totp', advanced: true },
    { key: 'notes', multiline: true, advanced: true },
  ],
  passkey: [
    { key: 'credential_id' },
    { key: 'rp_id', placeholder: 'rpId' },
    { key: 'notes', multiline: true, advanced: true },
  ],
  bank_account: [
    { key: 'bank_name' },
    { key: 'account_number', secret: true },
    { key: 'holder_name', advanced: true },
    { key: 'currency', placeholder: 'currency', advanced: true },
    { key: 'branch', advanced: true },
    { key: 'notes', multiline: true, advanced: true },
  ],
  card: [
    { key: 'brand' },
    { key: 'card_type' },
    { key: 'cardholder' },
    { key: 'card_number', secret: true },
    { key: 'expiry', placeholder: 'expiry' },
    { key: 'cvv', secret: true },
    { key: 'credit_limit' },
    { key: 'statement_day' },
    { key: 'notes', multiline: true, advanced: true },
  ],
  identity: [
    { key: 'full_name' },
    { key: 'document_number', secret: true },
    { key: 'issued_date', advanced: true },
    { key: 'expiry_date', advanced: true },
    { key: 'notes', multiline: true, advanced: true },
  ],
  ssh_key: [
    { key: 'public_key', multiline: true },
    { key: 'private_key_ref', secret: true, advanced: true },
    { key: 'comment', advanced: true },
    { key: 'notes', multiline: true, advanced: true },
  ],
  api_key: [
    { key: 'service' },
    { key: 'key', secret: true },
    { key: 'scopes', advanced: true },
    { key: 'expires_at', advanced: true },
    { key: 'notes', multiline: true, advanced: true },
  ],
  secure_note: [
    { key: 'body', multiline: true },
    { key: 'checklist', multiline: true, advanced: true },
  ],
  document: [
    { key: 'blob_id' },
    { key: 'mime_type', placeholder: 'mimeDocument', advanced: true },
    { key: 'notes', multiline: true, advanced: true },
  ],
  media: [
    { key: 'blob_id' },
    { key: 'mime_type', placeholder: 'mimeMedia', advanced: true },
    { key: 'width', advanced: true },
    { key: 'height', advanced: true },
    { key: 'duration_s', advanced: true },
    { key: 'notes', multiline: true, advanced: true },
  ],
  collection: [{ key: 'description', multiline: true }],
  custom: [{ key: 'description', multiline: true }],
};

const INTERNAL_FIELDS = new Set(['parent_id', 'password_history', 'revisions', 'archived']);

function newItemId(): string {
  const b = crypto.randomBytes(16);
  return 'item_' + Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

export default function ItemFormScreen({ initial, allItems, onSave, onDirtyChange }: {
  initial?: VaultItem; allItems: VaultItem[];
  onSave: (item: VaultItem, localCardCode?: string) => void | Promise<void>; onDirtyChange?: (dirty: boolean) => void;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  const { colors, styles } = useMobileTheme();
  const { dict, t } = useTranslation();
  const [more, setMore] = useState(false);
  const [relationsOpen, setRelationsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [type, setType] = useState<ItemType>(initial?.type ?? 'login');
  const [title, setTitle] = useState(() => initial?.type === 'card' ? cardIssuer(initial.title, initial.fields.bank) : initial?.title ?? '');
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
  const [fields, setFields] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(initial?.fields ?? {})) if (typeof v === 'string') out[k] = v;
    return out;
  });
  const drafts = useRef<Partial<Record<ItemType, Record<string, string>>>>({});
  const titleInput = useRef<TextInput>(null);
  const requiredInput = useRef<TextInput>(null);
  const [missingField, setMissingField] = useState<'title' | 'username' | 'bank_name'>();
  const [visibleSecret, setVisibleSecret] = useState<keyof Dictionary['fields']>();
  const [addingCustom, setAddingCustom] = useState(false);
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
  const setF = (key: string, value: string) => {
    setFields((current) => ({ ...current, [key]: value }));
    if (key === missingField) setMissingField(undefined);
  };

  function changeType(next: ItemType) {
    if (next === type) return;
    // New items can try different templates without mixing their drafts.
    // Existing items retain their saved fields when they are reclassified.
    if (!initial) {
      drafts.current[type] = fields;
      setFields(drafts.current[next] ?? {});
    }
    setType(next);
    setMissingField(undefined);
    setVisibleSecret(undefined);
    setShowPreview(false);
    setError('');
  }

  const otherDrafts = Object.entries(drafts.current).filter(([draftType, draft]) =>
    draftType !== type && Object.values(draft).some((value) => value.trim()),
  );
  const signature = JSON.stringify({ type, title, fields, otherDrafts, tagsText, relationIds, favorite, parentId, customKey, customValue, cardCodeEdited: localCardCode !== undefined });
  const baseline = useRef(signature);
  useEffect(() => { onDirtyChange?.(signature !== baseline.current); }, [signature, onDirtyChange]);

  async function handleSave() {
    if (saving) return;
    setError('');
    if (!title.trim()) {
      setMissingField('title');
      titleInput.current?.focus();
      return;
    }
    const required = type === 'login' ? 'username' : type === 'bank_account' ? 'bank_name' : undefined;
    if (required && !fields[required]?.trim()) {
      setMissingField(required);
      requiredInput.current?.focus();
      return;
    }
    if (type === 'card') {
      const issue = cardInputError(fields, localCardCode ?? '');
      if (issue) {
        setError(dict.card[issue]);
        return;
      }
    }
    Keyboard.dismiss();
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
    if (type === 'card') prepareCardFields(cleaned);
    const item: VaultItem = {
      id: initial?.id ?? newItemId(), type, schema_version: 1, title: title.trim(),
      fields: cleaned,
      tags: tagsText.split(',').map((t) => t.trim()).filter(Boolean),
      // Keep existing relation types; only newly linked items default to related_to.
      relations: relationIds.map((id) => (initial?.relations ?? []).find((r) => r.target_id === id) ?? { type: 'related_to', target_id: id }),
      attachments: initial?.attachments ?? [], favorite,
      created_at: initial?.created_at ?? now, updated_at: now,
    };
    setSaving(true);
    try {
      await onSave(item, type === 'card' ? localCardCode : undefined);
    } catch {
      setError(t('mobileUI.saveFailed'));
    } finally {
      setSaving(false);
    }
  }
  const save = useRef(handleSave);
  useLayoutEffect(() => { save.current = handleSave; });
  const saveLabel = saving ? dict.itemForm.saving : dict.itemForm.save;
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          testID="save-item-button"
          accessibilityRole="button"
          accessibilityLabel={saveLabel}
          accessibilityState={{ disabled: saving, busy: saving }}
          disabled={saving}
          onPress={() => void save.current()}
          style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8, opacity: saving || pressed ? 0.55 : 1 })}
        >
          <Text style={{ color: colors.link, fontSize: 16, fontWeight: '700' }}>{saveLabel}</Text>
        </Pressable>
      ),
    });
  }, [navigation, saving, saveLabel, colors.link]);

  const types = initial && !CREATABLE_TYPES.includes(initial.type) ? [initial.type, ...CREATABLE_TYPES] : CREATABLE_TYPES;
  const definitions = FIELDS[type];
  const titleError = missingField === 'title' ? dict.itemForm.titleRequired : undefined;
  const isFixedField = (key: string) => definitions.some((field) => field.key === key) || INTERNAL_FIELDS.has(key)
    || (type === 'card' && (key === 'last4' || key === 'bank' || isCardVerificationField(key)));
  const parentCandidates = more && type === 'collection' ? allItems.filter((item) => item.type === 'collection' && item.id !== initial?.id) : [];
  const relatable = more ? allItems.filter((item) => item.id !== initial?.id) : [];
  const customFields = Object.keys(fields).filter((key) => !isFixedField(key));

  const renderCustomFields = () => (
    <>
      {(customFields.length > 0 || addingCustom) && (
        <View style={{ padding: 16 }}>
          {customFields.map((key) => (
            <Field key={key} testID={`custom-${key}`} label={key} value={fields[key]} onChangeText={(value) => setF(key, value)} autoCapitalize="none" secureTextEntry={key === 'card_number'} />
          ))}
          {addingCustom && (
            <>
              <Field label={dict.itemForm.customName} testID="custom-field-name" value={customKey} onChangeText={setCustomKey} autoCapitalize="none" />
              <Field label={dict.itemForm.customValue} testID="custom-field-value" value={customValue} onChangeText={setCustomValue} autoCapitalize="none" />
              <Action
                testID="add-custom-field"
                label={dict.itemForm.addCustom}
                disabled={!customKey.trim() || !customValue.trim() || (type === 'card' && isFixedField(customKey.trim()))}
                onPress={() => {
                  setF(customKey.trim(), customValue.trim());
                  setCustomKey('');
                  setCustomValue('');
                  setAddingCustom(false);
                }}
              />
            </>
          )}
        </View>
      )}
      {!addingCustom && (
        <Row testID="show-custom-fields" label={dict.itemForm.addCustom} onPress={() => setAddingCustom(true)}>
          <Icon name="add" size="lg" color={colors.link} />
        </Row>
      )}
    </>
  );

  const renderField = (field: ItemField) => {
    const { key } = field;
    const revealed = visibleSecret === key;
    const value = key === 'cvv' ? localCardCode ?? loadedCode : fields[key] ?? '';
    const label = key === 'username' ? t('mobileUI.loginUsername') : dict.fields[key];
    const required = key === 'username' || key === 'bank_name';
    if (type === 'card' && (key === 'brand' || key === 'card_type')) {
      const choices = key === 'brand'
        ? [{ value: '', label: dict.card.chooseBrand }, ...cardBrands(value).map((network) => ({ value: network, label: network === 'other' ? dict.card.otherBrand : network }))]
        : [{ value: '', label: dict.card.chooseType }, ...CARD_TYPES.map((kind) => ({ value: kind, label: dict.card[kind] }))];
      return (
        <View key={key} style={{ marginBottom: 14 }}>
          <Text style={styles.label}>{label}</Text>
          <Select testID={`field-${key}`} label={label} value={value} choices={choices} onChange={(next) => setF(key, next)} />
        </View>
      );
    }
    const hint = key === 'cvv' ? dict.card.cvvHint
      : key === 'card_number' && !value && fields.last4 ? format(dict.card.existingDigits, fields.last4) : undefined;
    const numeric = key === 'statement_day' || key === 'card_number' || key === 'cvv';
    return (
      <View key={key} style={hint ? { marginBottom: 14 } : undefined}>
        <Field
          ref={required ? requiredInput : undefined}
          label={label}
          testID={`field-${key}`}
          placeholder={key === 'credit_limit' ? dict.card.limitPlaceholder : key === 'statement_day' ? dict.card.dayPlaceholder : field.placeholder && dict.placeholders[field.placeholder]}
          secureTextEntry={field.secret && !revealed}
          multiline={field.multiline}
          value={value}
          onChangeText={(next) => key === 'cvv' ? setLocalCardCode(next) : setF(key, next)}
          autoCapitalize={field.multiline ? 'sentences' : 'none'}
          autoCorrect={key === 'body' || key === 'notes'}
          autoComplete="off"
          keyboardType={key === 'url' ? 'url' : numeric ? 'number-pad' : 'default'}
          maxLength={key === 'cvv' ? 4 : undefined}
          flush={!!hint}
          accessibilityHint={hint}
          error={key === 'cvv' && codeReadFailed ? dict.card.codeReadFailed : missingField === key ? format(dict.mobileUI.requiredField, label) : undefined}
          trailing={field.secret && (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <IconButton
                testID={`field-${key}-visibility`}
                accessibilityLabel={format(revealed ? dict.itemDetail.hide : dict.itemDetail.show, label)}
                accessibilityState={{ selected: revealed }}
                onPress={() => setVisibleSecret(revealed ? undefined : key)}
              >
                <Icon name={revealed ? 'hide' : 'show'} color={colors.secondary} size="lg" />
              </IconButton>
              {key === 'password' && (
                <IconButton
                  testID="generate-password-button"
                  accessibilityLabel={dict.mobileUI.generatePassword}
                  onPress={() => {
                    try {
                      setF(key, generatePassword({ length: 20 }));
                      setError('');
                    } catch {
                      setError(dict.mobileUI.generatePasswordFailed);
                    }
                  }}
                >
                  <Icon name="generate" color={colors.link} size="lg" />
                </IconButton>
              )}
            </View>
          )}
        />
        {hint && <Text style={[styles.small, { marginTop: 4 }]}>{hint}</Text>}
        {key === 'password' && !!value && <StrengthMeter password={value} />}
        {key === 'body' && !!value && (
          <Group>
            <Row testID="preview-markdown-button" label={showPreview ? dict.itemForm.hidePreview : dict.itemForm.preview} expanded={showPreview} onPress={() => setShowPreview((open) => !open)}>
              <Icon name={showPreview ? 'hide' : 'show'} color={colors.secondary} size="lg" />
            </Row>
            {showPreview && <View style={{ padding: 16 }}><MarkdownText source={value} /></View>}
          </Group>
        )}
      </View>
    );
  };

  return (
    <Page>
      <Select
        testID="item-type"
        label={t('mobileUI.itemType')}
        value={type}
        choices={types.map((option) => ({
          value: option,
          label: dict.itemTypes[option],
          icon: <Icon name={moduleIcon[option]} color={colors.link} size="lg" />,
        }))}
        onChange={(value) => changeType(value as ItemType)}
        style={{ marginBottom: 20 }}
      />
      {type === 'login' ? (
        <View style={{ marginBottom: 14 }}>
          <Text style={styles.label}>{dict.itemForm.loginService}</Text>
          <Select
            testID="item-title"
            label={dict.itemForm.loginService}
            value={title}
            choices={loginServiceNames(allItems, title).map((name) => ({ value: name, label: name }))}
            createLabel={(name) => format(dict.itemForm.createLoginService, name)}
            placeholder={dict.itemForm.loginServicePlaceholder}
            onChange={(value) => { setTitle(value); setMissingField(undefined); }}
          />
          {titleError && <Text accessibilityRole="alert" style={styles.error}>{dict.itemForm.loginServiceRequired}</Text>}
        </View>
      ) : (
        <Field
          ref={titleInput}
          label={type === 'card' ? dict.card.issuer : dict.itemForm.title}
          testID="item-title"
          placeholder={type === 'card' ? dict.card.issuerPlaceholder : dict.placeholders.title}
          value={title}
          onChangeText={(value) => { setTitle(value); setMissingField(undefined); }}
          autoCapitalize="sentences"
          error={titleError && (type === 'card' ? dict.card.issuerRequired : titleError)}
        />
      )}
      {definitions.filter(({ key, advanced }) => !advanced && (type !== 'card' || fields.card_type === 'credit' || (key !== 'credit_limit' && key !== 'statement_day'))).map(renderField)}
      {type === 'custom' && <Group>{renderCustomFields()}</Group>}
      {!!error && <Text testID="form-error" accessibilityRole="alert" style={[styles.error, { marginBottom: 14 }]}>{error}</Text>}
      <Group>
        <Row testID="item-more-options" label={t('mobileUI.advancedOptions')} expanded={more} onPress={() => setMore((open) => !open)}>
          <View style={{ transform: [{ rotate: more ? '180deg' : '0deg' }] }}>
            <Icon name="expand" color={colors.secondary} size="lg" />
          </View>
        </Row>
      </Group>
      {more && (
        <>
          {definitions.filter((field) => field.advanced).map(renderField)}
          {type === 'collection' && (
            <View style={{ marginBottom: 14 }}>
              <Text style={styles.label}>{dict.itemForm.parentAria}</Text>
              <Select
                testID="item-parent"
                label={dict.itemForm.parentAria}
                value={parentId}
                choices={[{ value: '', label: t('mobileUI.noParent') }, ...parentCandidates.map((item) => ({ value: item.id, label: item.title }))]}
                onChange={setParentId}
              />
            </View>
          )}
          <Field label={dict.itemForm.tags} testID="item-tags" placeholder={dict.placeholders.tags} value={tagsText} onChangeText={setTagsText} autoCapitalize="none" />
          <Group>
            <ToggleRow testID="item-favorite-toggle" label={dict.itemForm.favorite} value={favorite} onChange={setFavorite} />
            {relatable.length > 0 && (
              <>
                <Rule />
                <Row
                  testID="item-relations"
                  label={t('mobileUI.relatedItems')}
                  detail={t('mobileUI.itemCount', relationIds.length)}
                  expanded={relationsOpen}
                  onPress={() => setRelationsOpen((open) => !open)}
                />
                {relationsOpen && relatable.map((item) => (
                  <ToggleRow
                    key={item.id}
                    testID={`relation-${item.id}`}
                    label={item.title}
                    value={relationIds.includes(item.id)}
                    onChange={(value) => setRelationIds((ids) => value ? [...ids, item.id] : ids.filter((id) => id !== item.id))}
                  />
                ))}
              </>
            )}
          </Group>
          {type !== 'custom' && <Group>{renderCustomFields()}</Group>}
        </>
      )}
    </Page>
  );
}
