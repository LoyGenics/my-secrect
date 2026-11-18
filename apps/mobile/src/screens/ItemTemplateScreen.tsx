import React, { useState } from 'react';
import type { ItemType } from '../../../../packages/core/src/types';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { moduleIcon } from '../../../../packages/ui/src/modules';
import { AppPage, Group, Rule, SettingsRow } from '../components/mobile-ui';
import type { FilePickerKind } from './FilesScreen';

const COMMON_TEMPLATES = ['login', 'bank_account', 'card', 'identity', 'secure_note'] as const;
const MORE_TEMPLATES = ['api_key', 'ssh_key', 'passkey', 'custom'] as const;

export default function ItemTemplateScreen({ onSelect, onImport }: { onSelect: (type: ItemType) => void; onImport: (kind: FilePickerKind) => void }) {
  const { dict, t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  return (
    <AppPage testID="item-template-screen" safeArea="bottom">
      <Group>
        {COMMON_TEMPLATES.map((type, index) => (
          <React.Fragment key={type}>
            {index > 0 && <Rule leading />}
            <SettingsRow testID={`template-${type}`} icon={moduleIcon[type]} label={dict.itemTypes[type]} navigation onPress={() => onSelect(type)} />
          </React.Fragment>
        ))}
      </Group>
      <Group title={t('mobileUI.fileSources')}>
        <SettingsRow testID="template-files" icon="documents" label={t('mobileUI.chooseDocs')} navigation onPress={() => onImport('document')} />
        <Rule leading />
        <SettingsRow testID="template-photos" icon="gallery" label={t('mobileUI.photos')} navigation onPress={() => onImport('photo')} />
      </Group>
      <Group>
        <SettingsRow testID="template-more" icon="more" label={dict.mobileEditor.moreTypes} expanded={expanded} onPress={() => setExpanded(value => !value)} />
        {expanded && MORE_TEMPLATES.map(type => (
          <React.Fragment key={type}>
            <Rule leading />
            <SettingsRow
              testID={`template-${type}`}
              icon={moduleIcon[type]}
              label={type === 'passkey' ? dict.mobileEditor.passkeyReference : dict.itemTypes[type]}
              detail={type === 'passkey' ? dict.mobileEditor.passkeyHelp : undefined}
              navigation
              onPress={() => onSelect(type)}
            />
          </React.Fragment>
        ))}
      </Group>
    </AppPage>
  );
}
