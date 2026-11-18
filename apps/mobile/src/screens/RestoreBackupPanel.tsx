import React, { useEffect, useState } from 'react';
import { BackHandler, Keyboard, Text, View } from 'react-native';
import * as Documents from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { isFile } from '../../../../packages/core/src/files';
import { formatDate, formatNumber } from '../../../../packages/i18n/src/index';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { parseEncryptedExportText, type ItemListCheck } from '../../../../packages/import-export/src/index';
import { describeRestoreError } from '../../../desktop/src/components/restoreErrors';
import AppTextField from '../components/Field';
import { AppButton, FieldGroup, InlineError, Progress, SegmentedControl } from '../components/mobile-ui';
import { useMobileTheme } from '../theme';
import { space } from '../ui/tokens';
import { listItems, lockVault, restoreEncrypted } from '../vault';

interface BackupPreview {
  name: string;
  text: string;
  itemCount: number;
  version: number;
  exportedAt: string;
}

export default function RestoreBackupPanel({ onRestored, onCancel }: { onRestored: () => void; onCancel: () => void }) {
  const { dict, locale, t, tp } = useTranslation();
  const { styles } = useMobileTheme();
  const { restore, mobileAuth: auth } = dict;
  const [backup, setBackup] = useState<BackupPreview | null>(null);
  const [mode, setMode] = useState<'passphrase' | 'recovery'>('passphrase');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ count: number; itemList: ItemListCheck; hasFiles: boolean } | null>(null);
  const [busy, setBusy] = useState<'pick' | 'restore' | null>(null);

  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!busy) {
        if (result) onRestored();
        else onCancel();
      }
      return true;
    });
    return () => back.remove();
  }, [busy, onCancel, onRestored, result]);

  function safeRestoreMessage(error: unknown): string {
    switch (describeRestoreError(error).kind) {
      case 'existing-vault': return auth.restoreExisting;
      case 'wrong-passphrase': return auth.restoreWrongPass;
      case 'wrong-recovery-key':
      case 'bad-recovery-key': return auth.restoreWrongRecovery;
      case 'tampered':
      case 'duplicate-ids': return auth.restoreTampered;
      case 'item-list-mismatch': return dict.backup.itemListMismatch;
      case 'unsupported-version': return auth.restoreUnsupported;
      case 'not-a-backup': return auth.restoreInvalid;
      case 'unknown': return auth.restoreFailed;
    }
  }

  async function selectBackup() {
    if (busy) return;
    Keyboard.dismiss();
    setError('');
    setBusy('pick');
    let cachedFile: string | undefined;
    try {
      const selected = await Documents.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
      if (selected.canceled) return;
      const file = selected.assets[0];
      if (!file) { setError(restore.readFailed); return; }
      setBackup(null);
      setSecret('');
      if (FileSystem.cacheDirectory && file.uri.startsWith(FileSystem.cacheDirectory)) cachedFile = file.uri;
      const text = await FileSystem.readAsStringAsync(file.uri);
      const { data, validation } = parseEncryptedExportText(text);
      if (!data) {
        const version = validation.formatVersion;
        if (version !== undefined && version !== 2 && version !== 3) setError(auth.restoreUnsupported);
        else setError(validation.duplicateIds.length ? auth.restoreTampered : auth.restoreInvalid);
        return;
      }
      setBackup({ name: file.name, text, itemCount: validation.itemCount, version: data.format_version, exportedAt: data.exported_at });
    } catch {
      setError(restore.readFailed);
    } finally {
      if (cachedFile) await FileSystem.deleteAsync(cachedFile, { idempotent: true }).catch(() => undefined);
      setBusy(null);
    }
  }

  async function submit() {
    if (busy) return;
    if (!backup) { setError(restore.chooseFile); return; }
    if (!secret.trim()) {
      setError(mode === 'passphrase' ? restore.enterPassphrase : restore.enterRecovery);
      return;
    }
    Keyboard.dismiss();
    setBusy('restore');
    setError('');
    try {
      const itemList = await restoreEncrypted(backup.text, mode === 'passphrase' ? { passphrase: secret } : { recoveryKey: secret });
      const items = listItems();
      lockVault();
      setSecret('');
      setBackup(null);
      setResult({ count: items.length, itemList, hasFiles: items.some(isFile) });
    } catch (error) {
      setError(safeRestoreMessage(error));
    } finally {
      setBusy(null);
    }
  }

  if (result) {
    return (
      <View testID="restore-success" style={{ gap: space[4] }}>
        <Text accessibilityRole="header" style={styles.heading}>{restore.successTitle}</Text>
        <Text style={styles.body}>{tp(restore.successBody, result.count)}</Text>
        {result.itemList === 'unverifiable-legacy'
          ? <InlineError testID="restore-item-list-unverified">{dict.backup.itemListUnverified}</InlineError>
          : <Text testID="restore-item-list-verified" style={styles.small}>{auth.restoreVerified}</Text>}
        {result.hasFiles && <Text style={styles.small}>{auth.recordsOnly}</Text>}
        <AppButton label={restore.continue} icon="unlock" testID="restore-continue" onPress={onRestored} />
      </View>
    );
  }

  const date = backup ? new Date(backup.exportedAt) : null;
  const formattedDate = date && !Number.isNaN(date.getTime()) ? formatDate(locale, date, { dateStyle: 'medium' }) : null;
  const choices = [
    { value: 'passphrase', label: restore.passphrase },
    { value: 'recovery', label: restore.recoveryKey },
  ];

  return (
    <FieldGroup>
      <AppButton label={busy === 'pick' ? auth.readingFile : backup ? auth.changeBackup : auth.pickBackup}
        icon="file" variant={backup ? 'secondary' : 'primary'} testID="restore-pick-file"
        loading={busy === 'pick'} disabled={busy === 'restore'} onPress={() => void selectBackup()} />
      {backup && (
        <>
          <View testID="restore-file-preview" style={[styles.card, { gap: space[1] }]}>
            <Text style={styles.label}>{auth.previewLabel}</Text>
            <Text style={styles.body}>{backup.name}</Text>
            <Text style={styles.small}>{t('mobileAuth.previewCount', formatNumber(locale, backup.itemCount))}</Text>
            <Text style={styles.small}>{t('mobileAuth.backupVersion', backup.version)}</Text>
            {formattedDate && <Text style={styles.small}>{t('mobileAuth.previewDate', formattedDate)}</Text>}
          </View>
          <Text style={styles.small}>{auth.recordsOnly}</Text>
          <SegmentedControl label={restore.credentialType} choices={choices} value={mode}
            testID="restore-mode" disabled={Boolean(busy)} onChange={(value) => {
              if (busy || (value !== 'passphrase' && value !== 'recovery')) return;
              setMode(value);
              setError('');
              setSecret('');
            }} />
          <AppTextField flush revealable label={mode === 'passphrase' ? restore.backupPassphrase : restore.recoveryKey}
            testID="restore-secret" value={secret} onChangeText={(value) => { setSecret(value); setError(''); }}
            autoComplete="off" autoCapitalize="none" autoCorrect={false} disabled={Boolean(busy)}
            returnKeyType="go" onSubmitEditing={() => void submit()} />
        </>
      )}
      {!!error && <InlineError testID="restore-error">{error}</InlineError>}
      {!!backup && (
        <AppButton label={busy === 'restore' ? restore.restoring : restore.restore} icon="restore"
          testID="restore-submit" loading={busy === 'restore'} disabled={busy === 'pick'} onPress={() => void submit()} />
      )}
      {busy === 'restore' && <Progress label={restore.restoring} testID="restore-progress" />}
      <AppButton label={restore.back} variant="text" testID="restore-cancel" disabled={Boolean(busy)} onPress={onCancel} />
    </FieldGroup>
  );
}
