import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { format } from '../../../../packages/i18n/src/index';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { useMobileTheme } from '../theme';
import { space } from '../ui/tokens';
import { CUSTOM_FIELD_KINDS, customFieldKey, normalizeWebsite, parseEditorDate, type CustomEditorField } from '../utils/itemEditor';
import { AppTextField } from './Field';
import { AppButton, BottomSheet, FieldGroup, FilterChip, FormSection, Group, IconButton, Rule, SettingsRow } from './mobile-ui';

type CustomDraft = { index: number; label: string; kind: CustomEditorField['kind']; value: string };

export default function EditorCustomFields({ fields, onChange, newKey, disabled }: {
  fields: CustomEditorField[]; onChange: (fields: CustomEditorField[]) => void; newKey: () => string; disabled?: boolean;
}) {
  const { dict } = useTranslation();
  const { styles } = useMobileTheme();
  const copy = dict.mobileEditor;
  const [draft, setDraft] = useState<CustomDraft | null>(null);
  const [actions, setActions] = useState<number>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const begin = (index: number) => {
    const field = fields[index];
    setError('');
    setDraft({ index, label: field?.label ?? '', kind: field?.kind ?? 'text', value: typeof field?.value === 'string' ? field.value : '' });
  };
  const move = (index: number, offset: -1 | 1) => {
    const next = [...fields];
    const [field] = next.splice(index, 1);
    next.splice(index + offset, 0, field);
    onChange(next);
    closeActions();
  };
  const closeActions = () => { setActions(undefined); setConfirmDelete(false); };
  const actionField = actions === undefined ? undefined : fields[actions];
  const save = () => {
    if (!draft) return;
    const name = draft.label.trim();
    if (!name) return;
    if (fields.some(({ label }, index) => index !== draft.index && label.toLowerCase() === name.toLowerCase())) {
      setError(copy.duplicateCustomName);
      return;
    }
    const value = draft.value;
    if (draft.kind === 'date' && value && !parseEditorDate(value)) {
      setError(copy.customDateError);
      return;
    }
    const url = draft.kind === 'url' && value ? normalizeWebsite(value) : undefined;
    if (draft.kind === 'url' && value && !url) {
      setError(copy.enterValidWebsite);
      return;
    }
    const previous = fields[draft.index];
    const keepKey = previous && name === previous.label && draft.kind === previous.kind;
    const field: CustomEditorField = {
      key: keepKey ? previous.key : customFieldKey(newKey(), draft.kind),
      label: name, kind: draft.kind, value: url?.url ?? value,
      typed: keepKey ? previous.typed : true,
    };
    const next = [...fields];
    next[draft.index] = field;
    onChange(next);
    setDraft(null);
  };
  const editValue = (field: CustomEditorField) => typeof field.value === 'string' || field.value === undefined;
  return (
    <>
      <FormSection title={dict.itemForm.customFields} description={fields.length ? undefined : copy.customFieldsHelp}>
        {fields.length > 0 && <Group>
          {fields.map((field, index) => (
            <React.Fragment key={field.key}>
              {index > 0 && <Rule />}
              <SettingsRow label={field.label} detail={copy.customTypes[field.kind]}>
                <View style={local.actions}>
                  {editValue(field) && <IconButton testID={`custom-${field.key}`} icon="edit"
                    accessibilityLabel={format(copy.editCustomField, field.label)} disabled={disabled} onPress={() => begin(index)} />}
                  <IconButton icon="more" accessibilityLabel={format(copy.customFieldActions, field.label)} disabled={disabled}
                    onPress={() => setActions(index)} />
                </View>
              </SettingsRow>
            </React.Fragment>
          ))}
        </Group>}
        <AppButton testID="show-custom-fields" label={dict.itemForm.addCustom} variant="secondary" icon="add" disabled={disabled} onPress={() => begin(fields.length)} />
      </FormSection>
      {actionField && actions !== undefined && <BottomSheet title={confirmDelete ? copy.removeCustomTitle : actionField.label}
        visible testID="custom-field-actions" onClose={closeActions}
        footer={confirmDelete && <AppButton label={dict.common.delete} testID="custom-field-confirm-delete" variant="destructive" onPress={() => {
          onChange(fields.filter(({ key }) => key !== actionField.key));
          closeActions();
        }} />}>
        {confirmDelete ? <Text style={styles.body}>{format(copy.removeCustomBody, actionField.label)}</Text> : <>
          {actions > 0 && <SettingsRow label={format(copy.moveCustomUp, actionField.label)} testID="custom-field-move-up" onPress={() => move(actions, -1)} />}
          {actions < fields.length - 1 && <SettingsRow label={format(copy.moveCustomDown, actionField.label)} testID="custom-field-move-down" onPress={() => move(actions, 1)} />}
          <SettingsRow label={format(copy.removeCustomField, actionField.label)} testID="custom-field-delete" icon="trash" destructive onPress={() => setConfirmDelete(true)} />
        </>}
      </BottomSheet>}
      {draft && <BottomSheet title={draft.index < fields.length ? format(copy.editCustomField, fields[draft.index].label) : dict.itemForm.addCustom}
        visible testID="custom-field-editor" onClose={() => setDraft(null)}
        footer={<AppButton testID="add-custom-field" label={dict.common.save} disabled={!draft.label.trim()} onPress={save} />}>
        <FieldGroup>
          <AppTextField flush label={dict.itemForm.customName} testID="custom-field-name" value={draft.label}
            autoCapitalize="sentences" onChangeText={(label) => { setDraft({ ...draft, label }); setError(''); }} />
          <FormSection title={copy.customFieldType} style={local.noMargin}>
            <View style={local.types}>
              {CUSTOM_FIELD_KINDS.map((kind) => <FilterChip key={kind} label={copy.customTypes[kind]} selected={draft.kind === kind}
                testID={`custom-field-type-${kind}`} onPress={() => { setDraft({ ...draft, kind }); setError(''); }} />)}
            </View>
          </FormSection>
          <AppTextField flush label={dict.itemForm.customValue} testID="custom-field-value" value={draft.value}
            revealable={draft.kind === 'secret'} multiline={draft.kind === 'multiline'} keyboardType={draft.kind === 'url' ? 'url' : 'default'}
            placeholder={draft.kind === 'date' ? 'YYYY-MM-DD' : undefined} autoCapitalize="none" autoCorrect={false} error={error}
            onChangeText={(value) => { setDraft({ ...draft, value }); setError(''); }} />
        </FieldGroup>
      </BottomSheet>}
    </>
  );
}

const local = StyleSheet.create({
  types: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  actions: { flexDirection: 'row' },
  noMargin: { marginBottom: 0 },
});
