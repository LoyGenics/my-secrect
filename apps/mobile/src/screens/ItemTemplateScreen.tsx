import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ItemType } from '../../../../packages/core/src/types';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { Icon } from '../../../../packages/ui/src/native';
import { InputControl } from '../components/Field';
import { IconButton } from '../components/mobile-ui';
import { TypeStamp } from '../components/ledger';
import { useMobileTheme } from '../theme';
import { radius, size, space, textStyle } from '../ui/tokens';
import { normalizeVaultQuery } from '../utils/vaultSearch';
import type { FilePickerKind } from './FilesScreen';

type Choice = { id: string; type: ItemType; template?: ItemType; picker?: FilePickerKind };
const GROUPS: ReadonlyArray<{ key: 'signIns' | 'money' | 'you' | 'notesFiles' | 'developer' | 'misc'; choices: Choice[] }> = [
  { key: 'signIns', choices: [{ id: 'login', type: 'login', template: 'login' }, { id: 'passkey', type: 'passkey', template: 'passkey' }] },
  { key: 'money', choices: [{ id: 'card', type: 'card', template: 'card' }, { id: 'bank_account', type: 'bank_account', template: 'bank_account' }] },
  { key: 'you', choices: [{ id: 'identity', type: 'identity', template: 'identity' }] },
  { key: 'notesFiles', choices: [
    { id: 'secure_note', type: 'secure_note', template: 'secure_note' },
    { id: 'files', type: 'document', picker: 'document' },
    { id: 'photos', type: 'media', picker: 'photo' },
  ] },
  { key: 'developer', choices: [{ id: 'api_key', type: 'api_key', template: 'api_key' }, { id: 'ssh_key', type: 'ssh_key', template: 'ssh_key' }] },
  { key: 'misc', choices: [{ id: 'custom', type: 'custom', template: 'custom' }] },
];

/** The New item sheet: a search over every type, grouped, each with its stamp and a one-line hint. */
export default function ItemTemplateScreen({ onSelect, onImport, onClose }: {
  onSelect: (type: ItemType) => void; onImport: (kind: FilePickerKind) => void; onClose?: () => void;
}) {
  const { dict, t, tp } = useTranslation();
  const { colors } = useMobileTheme();
  const editor = dict.mobileEditor;
  const [query, setQuery] = useState('');
  const label = (choice: Choice) => choice.picker === 'document' ? t('mobileUI.chooseDocs') : choice.picker === 'photo' ? t('mobileUI.photos')
    : choice.type === 'passkey' ? editor.passkeyReference : dict.itemTypes[choice.type];
  const total = GROUPS.reduce((sum, group) => sum + group.choices.length, 0);
  const needle = normalizeVaultQuery(query);
  const groups = GROUPS.map((group) => ({
    ...group,
    choices: group.choices.filter((choice) => !needle
      || normalizeVaultQuery(`${label(choice)} ${editor.chooserHints[choice.type]}`).includes(needle)),
  })).filter((group) => group.choices.length);

  return (
    <View testID="item-template-screen" style={[local.flex, { backgroundColor: colors.surface }]}>
      <View style={local.header}>
        <Text accessibilityRole="header" style={[textStyle.title, local.flex, { color: colors.text }]}>{editor.chooserTitle}</Text>
        {onClose && <IconButton testID="templates-close" icon="close" accessibilityLabel={dict.common.close} onPress={onClose} />}
      </View>
      <View style={local.search}>
        <InputControl boxed testID="template-search" containerStyle={local.searchBox} value={query} onChangeText={setQuery}
          accessibilityLabel={tp(editor.searchTypes, total)} placeholder={tp(editor.searchTypes, total)}
          autoCapitalize="none" autoCorrect={false} leading={<Icon name="search" color={colors.secondaryText} />} />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={local.list}>
        {groups.map((group) => <View key={group.key} style={local.group}>
          <Text accessibilityRole="header" style={[textStyle.strong, local.groupTitle, { color: colors.plum }]}>{editor.chooserGroups[group.key]}</Text>
          {group.choices.map((choice, index) => (
            <Pressable key={choice.id} testID={`template-${choice.id}`} accessibilityRole="button" accessibilityLabel={label(choice)}
              accessibilityHint={editor.chooserHints[choice.type]}
              onPress={() => choice.picker ? onImport(choice.picker) : onSelect(choice.template ?? choice.type)}
              style={({ pressed }) => [local.row, pressed && { backgroundColor: colors.selection }]}>
              <TypeStamp type={choice.type} />
              <View style={[local.rowText, index > 0 && local.rule, { borderTopColor: colors.border }]}>
                <Text style={[textStyle.strong, { color: colors.text }]}>{label(choice)}</Text>
                <Text style={[textStyle.caption, { color: colors.secondaryText }]} numberOfLines={1}>{editor.chooserHints[choice.type]}</Text>
              </View>
            </Pressable>
          ))}
        </View>)}
      </ScrollView>
    </View>
  );
}

const local = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  header: { flexDirection: 'row', alignItems: 'center', paddingLeft: space[4], paddingRight: space[2], paddingTop: space[6], paddingBottom: space[2] },
  search: { paddingHorizontal: space[4], paddingBottom: space[2] },
  searchBox: { borderRadius: radius.search },
  list: { paddingBottom: space[8] },
  group: { paddingTop: space[4] },
  groupTitle: { paddingHorizontal: space[4], paddingBottom: space[1] },
  row: { minHeight: size.chooserRow, flexDirection: 'row', alignItems: 'center', paddingLeft: space[4], gap: space[3] },
  rowText: { flex: 1, minWidth: 0, alignSelf: 'stretch', justifyContent: 'center', paddingVertical: space[2], paddingRight: space[4] },
  rule: { borderTopWidth: StyleSheet.hairlineWidth },
});
