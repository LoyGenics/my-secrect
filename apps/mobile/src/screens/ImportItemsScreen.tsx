import React, { useEffect, useRef, useState } from 'react';
import { FlatList, Keyboard, Linking, Text, View } from 'react-native';
import { Buffer } from 'buffer';
import type { VaultItem } from '../../../../packages/core/src/types';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { format } from '../../../../packages/i18n/src/index';
import { MAX_IMPORT_ITEMS } from '../../../../packages/import-export/src/index';
import { Icon } from '../../../../packages/ui/src/native';
import {
  AiImportError, buildCsvPreview, fieldText, MAX_AI_SOURCE_BYTES, OPENAI_DATA_POLICY, previewDuplicates, type ImportPreview,
} from '../../../../packages/import-export/src/itemImport';
import { AppTextField } from '../components/Field';
import {
  AppButton, AppPage, BottomSheet, FormSection, Group, InlineError, SegmentedControl, SettingsRow,
} from '../components/mobile-ui';
import { useMobileTheme } from '../theme';
import { space, textStyle } from '../ui/tokens';
import { chooseImportCsv, requestAiPreview, saveCsvTemplate } from '../utils/itemImport';
import { isValidBase32Secret } from '../utils/totp';

type Mode = 'csv' | 'ai';
type Work = 'file' | 'ai' | 'template' | 'saving';
type Preview = ImportPreview & { duplicates: Map<string, boolean> };

interface Props {
  items: VaultItem[];
  apiBaseUrl: string;
  getToken: () => Promise<string | null>;
  onImport: (items: VaultItem[]) => Promise<void>;
  onUnauthorized: () => void;
}

export default function ImportItemsScreen({ items, apiBaseUrl, getToken, onImport, onUnauthorized }: Props) {
  const { colors } = useMobileTheme();
  const { dict, tp } = useTranslation();
  const c = dict.itemImport;
  const [mode, setMode] = useState<Mode>('csv');
  const [sourceText, setSourceText] = useState('');
  const [consentOpen, setConsentOpen] = useState(false);
  const [work, setWork] = useState<Work | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const pending = useRef<AbortController | null>(null);
  const sourceTooLarge = Buffer.byteLength(sourceText, 'utf8') > MAX_AI_SOURCE_BYTES;
  const busy = work !== null;

  useEffect(() => () => pending.current?.abort(), []);

  function clearPreview() {
    setPreview(null);
    setSelected(new Set());
    setRevealed(null);
    setError('');
    setDone('');
  }

  function switchMode(next: Mode) {
    if (next === mode) return;
    setConsentOpen(false);
    setSourceText('');
    clearPreview();
    setMode(next);
  }

  function stage(data: ImportPreview) {
    const duplicates = previewDuplicates(data.items, items);
    setPreview({ ...data, duplicates });
    setSelected(new Set(data.items.filter(item => !duplicates.has(item.id)).map(item => item.id)));
    if (data.items.length === 0 && data.skipped.length === 0) setError(c.noItems);
  }

  async function run(action: Work, failure: string, task: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setWork(action);
    setError('');
    try {
      await task(controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return;
      const status = err instanceof AiImportError ? err.status : 0;
      if (status === 401) onUnauthorized();
      else setError(status === 429 ? c.rateLimited : status === 503 ? c.aiUnavailable : failure);
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setWork(null);
    }
  }

  function pickFile() {
    return run('file', c.readFailed, async (signal) => {
      clearPreview();
      const file = await chooseImportCsv(signal);
      if (!file || signal.aborted) return;
      if ('tooLarge' in file) {
        setError(c.fileTooLarge);
        return;
      }
      const result = buildCsvPreview(file.text, isValidBase32Secret);
      if ('error' in result) {
        setError(result.error === 'too_many_rows' ? format(c.tooManyRows, MAX_IMPORT_ITEMS) : c.csvErrors[result.error]);
        return;
      }
      stage(result.preview);
    });
  }

  function approveAiImport() {
    if (!consentOpen || !sourceText.trim() || sourceTooLarge) return;
    setConsentOpen(false);
    return run('ai', c.aiFailed, async (signal) => {
      clearPreview();
      const result = await requestAiPreview(apiBaseUrl, sourceText, getToken, signal);
      if (signal.aborted) return;
      setSourceText('');
      stage(result);
    });
  }

  function saveSelected() {
    const chosen = preview?.items.filter(item => selected.has(item.id)) ?? [];
    if (chosen.length === 0) return;
    return run('saving', c.failed, async (signal) => {
      await onImport(chosen);
      if (signal.aborted) return;
      clearPreview();
      setDone(tp(c.imported, chosen.length));
    });
  }

  const header = (
    <FormSection style={{ paddingBottom: space[3] }}>
      <SegmentedControl label={c.method} value={mode} testID="import-method" disabled={busy}
        choices={[{ value: 'csv', label: c.csvTab }, { value: 'ai', label: c.aiTab }]}
        onChange={value => switchMode(value === 'ai' ? 'ai' : 'csv')} />
      {mode === 'csv' ? (
        <>
          <Text style={[textStyle.helper, { color: colors.secondaryText }]}>{c.csvLede}</Text>
          <AppButton testID="import-choose-csv" label={work === 'file' ? c.reading : c.choose} icon="import"
            onPress={() => void pickFile()} loading={work === 'file'} disabled={busy} />
          <AppButton testID="import-download-template" label={c.template} icon="export" variant="secondary"
            onPress={() => void run('template', c.templateFailed, saveCsvTemplate)} loading={work === 'template'} disabled={busy} />
        </>
      ) : (
        <>
          <AppTextField testID="import-source-text" label={c.textLabel} helper={c.textHint} error={sourceTooLarge ? c.textTooLarge : undefined}
            value={sourceText} onChangeText={setSourceText} multiline scrollEnabled autoComplete="off" spellCheck={false}
            autoCorrect={false} autoCapitalize="none" disabled={busy} />
          <AppButton testID="import-request-consent" label={work === 'ai' ? c.analyzing : c.analyze}
            onPress={() => { Keyboard.dismiss(); setConsentOpen(true); }}
            loading={work === 'ai'} disabled={busy || sourceTooLarge || !sourceText.trim()} />
        </>
      )}
      {error && <InlineError testID="import-error">{error}</InlineError>}
      {done && <Text testID="import-success" accessibilityLiveRegion="polite" style={[textStyle.helper, { color: colors.okText }]}>{done}</Text>}
      {preview && preview.skipped.length > 0 && (
        <Text accessibilityLiveRegion="polite" style={[textStyle.helper, { color: colors.secondaryText }]}>
          {tp(mode === 'csv' ? c.csvSkipped : c.aiSkipped, preview.skipped.length,
            preview.skipped.slice(0, 8).join(', ') + (preview.skipped.length > 8 ? '…' : ''))}
        </Text>
      )}
      {preview && preview.items.length > 0 && (
        <Text accessibilityLiveRegion="polite" style={[textStyle.body, { color: colors.text }]}>
          {tp(c.found, preview.items.length, preview.source)} · {format(c.selected, selected.size)}
        </Text>
      )}
    </FormSection>
  );

  return (
    <>
      <AppPage testID="item-import-screen" scroll={false} safeArea="bottom" footer={preview && preview.items.length > 0 ? (
        <View style={{ gap: space[2] }}>
          <AppButton testID="import-save-selected" label={work === 'saving' ? c.importing : format(c.importSelected, selected.size)}
            icon="import" loading={work === 'saving'} disabled={busy || selected.size === 0} onPress={() => void saveSelected()} />
          <AppButton label={dict.common.cancel} variant="secondary" disabled={busy} onPress={clearPreview} />
        </View>
      ) : undefined}>
        <FlatList
          data={preview?.items}
          extraData={selected}
          keyExtractor={item => item.id}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={header}
          contentContainerStyle={{ gap: space[2], paddingBottom: space[4] }}
          renderItem={({ item, index }) => {
            const duplicate = preview?.duplicates.get(item.id);
            const visibleDetails = revealed === item.id;
            const detail = [dict.itemTypes[item.type], fieldText(item, 'username'), fieldText(item, 'url')].filter(Boolean).join(' · ');
            return (
              <Group>
                <SettingsRow testID={`import-preview-item-${index}`} label={item.title} detail={detail}
                  accessibilityRole="checkbox" accessibilityState={{ checked: selected.has(item.id) }} disabled={busy}
                  onPress={() => setSelected(current => {
                    const next = new Set(current);
                    if (!next.delete(item.id)) next.add(item.id);
                    return next;
                  })} />
                <View style={{ paddingHorizontal: space[3], gap: space[1] }}>
                  {duplicate !== undefined && <Text style={[textStyle.helper, { color: colors.secondaryText }]}>{duplicate ? c.duplicateBatch : c.duplicateVault}</Text>}
                  {preview?.totpOmitted.has(item.id) && <Text style={[textStyle.helper, { color: colors.secondaryText }]}>{c.totpOmitted}</Text>}
                  {item.type === 'login' && !fieldText(item, 'password') && <Text style={[textStyle.helper, { color: colors.secondaryText }]}>{c.noPassword}</Text>}
                </View>
                {mode === 'ai' && (
                  <>
                    <SettingsRow label={c.reviewFields} expanded={visibleDetails}
                      onPress={() => setRevealed(visibleDetails ? null : item.id)} />
                    {visibleDetails && <View style={{ padding: space[3], gap: space[2] }}>
                      {Object.entries(item.fields).map(([key, value]) => <View key={key}>
                        <Text style={[textStyle.helper, { color: colors.secondaryText }]}>{dict.fields[key as keyof typeof dict.fields] ?? key}</Text>
                        <Text style={[textStyle.body, { color: colors.text }]}>{String(value)}</Text>
                      </View>)}
                    </View>}
                  </>
                )}
              </Group>
            );
          }}
        />
      </AppPage>
      <BottomSheet testID="import-consent" visible={consentOpen} title={c.consentTitle} onClose={() => setConsentOpen(false)}
        footer={<View style={{ gap: space[2] }}>
          <AppButton testID="import-consent-accept" label={c.acceptAndSend} onPress={() => void approveAiImport()} />
          <AppButton testID="import-consent-decline" label={c.csvInstead} variant="secondary" onPress={() => switchMode('csv')} />
        </View>}>
        <FormSection description={c.consentDescription}>
          <Text style={[textStyle.helper, { color: colors.secondaryText }]}>{c.consentData}</Text>
          <Text style={[textStyle.helper, { color: colors.secondaryText }]}>{c.consentLiability}</Text>
          <SettingsRow label={c.dataPolicy} icon={<Icon name="open" color={colors.primaryTextLink} />}
            onPress={() => void Linking.openURL(OPENAI_DATA_POLICY).catch(() => undefined)} />
        </FormSection>
      </BottomSheet>
    </>
  );
}
