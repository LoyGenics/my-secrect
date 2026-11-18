import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, FlatList, Image, InteractionManager, Pressable, Text, View, useWindowDimensions } from 'react-native';
import * as Documents from 'expo-document-picker';
import * as Photos from 'expo-image-picker';
import * as FS from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { VideoView, useVideoPlayer } from 'expo-video';
import type { VaultItem } from '../../../../packages/core/src/types';
import { availableFileDestinations, fileParent, isFileEntry, isFileFolder, moveFileEntry } from '../../../../packages/core/src/files';
import { libsodiumAdapter } from '../../../../packages/crypto-adapters/src/index';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { Icon, illustrations } from '../../../../packages/ui/src/native';
import { AppButton, AppPage, BottomSheet, EmptyState, FormSection, Group, IconButton, InlineError, PageSection, Progress, Rule, SettingsRow } from '../components/mobile-ui';
import { AppTextField } from '../components/Field';
import { radius, size, space, textStyle } from '../ui/tokens';
import { useMobileTheme } from '../theme';
import { importNativeFile, openNativeFile, removeEncryptedFile } from '../storage/localFiles';
import { removeFilePreview } from '../storage/filePreviews';
import { isUnlocked } from '../vault';

function id() {
  const bytes = libsodiumAdapter.randomBytes(16); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function fileSize(value: unknown): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
function FileGlyph({ item }: { item: VaultItem }) {
  const { colors } = useMobileTheme();
  const mime = String(item.fields.mime_type ?? '');
  const glyph = isFileFolder(item) ? 'collections' : mime.startsWith('image/') ? 'gallery' : mime.startsWith('video/') ? 'video' : 'genericFile';
  return <View style={{ width: size.touch, height: size.touch, alignItems: 'center', justifyContent: 'center', borderRadius: radius.glyph, backgroundColor: colors.surface2 }}><Icon name={glyph} size="xl" color={colors.secondary} /></View>;
}

export type FilePickerKind = 'document' | 'photo';
interface Props {
  items: VaultItem[];
  folderId?: string;
  initialPicker?: FilePickerKind;
  onSave: (item: VaultItem) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onOpenFolder: (id: string) => void;
  onOpenFile: (id: string) => void;
}

interface FileRowProps {
  item: VaultItem;
  subtitle: string;
  onOpen: () => void;
  onActions: () => void;
}

function FileRow({ item, subtitle, onOpen, onActions }: FileRowProps) {
  const { colors } = useMobileTheme();
  const { t } = useTranslation();
  return (
    <View style={{ backgroundColor: colors.card, flexDirection: 'row', alignItems: 'center' }}>
      <Pressable testID={`file-entry-${item.id}`} accessibilityRole="button" accessibilityLabel={item.title} onLongPress={onActions} onPress={onOpen}
        style={({ pressed }) => ({ flex: 1, minHeight: size.fileRow, padding: space[4], flexDirection: 'row', alignItems: 'center', gap: space[3], backgroundColor: pressed ? colors.surface2 : colors.card })}>
        <FileGlyph item={item} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[textStyle.item, { color: colors.text }]} numberOfLines={2}>{item.title}</Text>
          {!!subtitle && <Text style={[textStyle.helper, { color: colors.muted }]}>{subtitle}</Text>}
        </View>
      </Pressable>
      <IconButton testID={`file-options-${item.id}`} accessibilityLabel={t('mobileUI.fileOptionsFor', item.title)} icon="more" onPress={onActions} />
    </View>
  );
}

export default function FilesScreen({ items, folderId = '', initialPicker, onSave, onDelete, onOpenFolder, onOpenFile }: Props) {
  const { colors } = useMobileTheme();
  const { t, tp, dict } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'folder' | 'rename'; item?: VaultItem } | null>(null);
  const [name, setName] = useState('');
  const [moving, setMoving] = useState<VaultItem | null>(null);
  const [menu, setMenu] = useState<VaultItem | null>(null);
  const pickerStarted = useRef(false);
  const { entries, childCounts } = useMemo(() => {
    const entries: VaultItem[] = [];
    const childCounts = new Map<string, number>();
    for (const item of items) {
      if (!isFileEntry(item) || item.deleted_at) continue;
      const parent = fileParent(item, items);
      if (parent === folderId) entries.push(item);
      childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
    }
    entries.sort((a, b) => Number(isFileFolder(b)) - Number(isFileFolder(a)) || a.title.localeCompare(b.title));
    return { entries, childCounts };
  }, [items, folderId]);
  const destinations = moving ? availableFileDestinations(moving, items) : [];
  async function importAssets(assets: Array<{ uri: string; name?: string; size?: number; mimeType?: string }>) {
    setBusy(true); setError('');
    try {
      for (const asset of assets) {
        const info = await FS.getInfoAsync(asset.uri);
        if (!info.exists || info.isDirectory) throw new Error('unreadable');
        try {
          const item = await importNativeFile({ uri: asset.uri, name: asset.name || t('mobileUI.unnamedFile'), size: asset.size ?? info.size, mimeType: asset.mimeType || 'application/octet-stream' }, folderId, setProgress);
          try { await onSave(item); } catch (error) {
            await removeEncryptedFile(item.id);
            throw error;
          }
        } finally {
          // Only picker-created cache copies, never a user's original file.
          if (FS.cacheDirectory && asset.uri.startsWith(FS.cacheDirectory)) await FS.deleteAsync(asset.uri, { idempotent: true }).catch(() => undefined);
        }
      }
    } catch (e) { setError(t(e instanceof Error && e.message === 'file_size' ? 'mobileUI.fileTooLarge' : 'mobileUI.uploadFailed')); }
    finally { setBusy(false); setProgress(0); }
  }
  async function chooseFiles() {
    try {
      setError('');
      const result = await Documents.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: '*/*' });
      if (!result.canceled) await importAssets(result.assets);
    } catch { setError(t('mobileUI.uploadFailed')); }
  }
  async function choosePhotos() {
    try {
      setError('');
      const result = await Photos.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, quality: 1 });
      if (!result.canceled) await importAssets(result.assets.map(asset => ({ uri: asset.uri, name: asset.fileName || `${t(asset.type === 'video' ? 'mobileUI.unnamedVideo' : 'mobileUI.unnamedPhoto')}-${Date.now()}.${asset.type === 'video' ? 'mp4' : 'jpg'}`, size: asset.fileSize, mimeType: asset.mimeType || (asset.type === 'video' ? 'video/mp4' : 'image/jpeg') })));
    } catch { setError(t('mobileUI.uploadFailed')); }
  }
  useEffect(() => {
    if (!initialPicker || pickerStarted.current) return;
    const task = InteractionManager.runAfterInteractions(() => {
      pickerStarted.current = true;
      void (initialPicker === 'photo' ? choosePhotos() : chooseFiles());
    });
    return () => task.cancel();
  }, [initialPicker]);

  function uploadMenu() {
    Alert.alert(t('mobileUI.upload'), undefined, [{ text: t('mobileUI.upload'), onPress: () => void chooseFiles() }, { text: t('mobileUI.photos'), onPress: () => void choosePhotos() }, { text: dict.common.cancel, style: 'cancel' }]);
  }
  async function saveName() {
    if (busy || !name.trim() || !dialog) return;
    setBusy(true); setError('');
    try {
      const now = new Date().toISOString();
      const item: VaultItem = dialog.item ? { ...dialog.item, title: name.trim(), updated_at: now } : { id: id(), type: 'collection', schema_version: 1, title: name.trim(), fields: { collection_kind: 'files', parent_id: folderId }, relations: [], attachments: [], tags: [], favorite: false, created_at: now, updated_at: now };
      await onSave(item); setDialog(null); setName('');
    } catch { setError(t('mobileUI.saveFailed')); } finally { setBusy(false); }
  }
  function confirmTrash(item: VaultItem) {
    setMenu(null);
    if (isFileFolder(item) && (childCounts.get(item.id) ?? 0) > 0) {
      setError(t('mobileUI.folderNotEmpty'));
      return;
    }
    Alert.alert(dict.mobile.moveToTrashTitle, undefined, [
      { text: dict.common.cancel, style: 'cancel' },
      { text: dict.common.delete, style: 'destructive', onPress: () => void onDelete(item.id).catch(() => setError(t('mobileUI.saveFailed'))) },
    ]);
  }

  async function moveTo(target = '') {
    if (!moving) return;
    setError(''); setBusy(true);
    try {
      await onSave(moveFileEntry(moving, target, items));
      setMoving(null);
    } catch { setError(t('mobileUI.saveFailed')); }
    finally { setBusy(false); }
  }

  const menuTitle = menu?.title ?? '';
  const editingName = dialog?.kind === 'folder' ? t('mobileUI.newFolder') : t('mobileUI.rename');
  const closeSheet = () => { setMenu(null); setMoving(null); setDialog(null); setError(''); };
  return (
    <AppPage width="list" scroll={false} testID="files-screen"
      header={
        <View style={{ gap: space[3], marginBottom: space[4] }}>
          <Text style={[textStyle.helper, { color: colors.muted }]}>{t('mobileUI.filesOnDevice')}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[3] }}>
            <AppButton testID="files-upload" label={t('mobileUI.upload')} icon="import" disabled={busy} onPress={uploadMenu} style={{ flexGrow: 1 }} />
            <AppButton testID="files-new-folder" label={t('mobileUI.newFolder')} variant="secondary" icon="newFolder" disabled={busy} onPress={() => { setError(''); setName(''); setDialog({ kind: 'folder' }); }} style={{ flexGrow: 1 }} />
          </View>
          {busy && !dialog && !moving && <Progress testID="files-import-progress" label={t('mobileUI.uploading', progress)} value={progress / 100} />}
          {!!error && !dialog && !moving && <InlineError testID="files-error">{error}</InlineError>}
        </View>
      }>
      <FlatList
        data={entries}
        keyExtractor={item => item.id}
        ItemSeparatorComponent={() => <View style={{ backgroundColor: colors.card }}><Rule leading /></View>}
        ListEmptyComponent={<EmptyState image={illustrations.emptyVault} title={t('mobileUI.filesEmpty')} detail={t('mobileUI.filesEmptyBody')} />}
        renderItem={({ item }) => {
          const folder = isFileFolder(item);
          const subtitle = folder ? tp(dict.mobileVault.itemCount, childCounts.get(item.id) ?? 0) : fileSize(item.fields.size_bytes);
          return <FileRow item={item} subtitle={subtitle} onOpen={() => folder ? onOpenFolder(item.id) : onOpenFile(item.id)} onActions={() => { if (!busy) setMenu(item); }} />;
        }}
      />
      <BottomSheet
        visible={Boolean(menu || dialog || moving)}
        title={moving ? t('mobileUI.moveTo') : dialog ? editingName : menuTitle}
        onClose={closeSheet}
        testID="files-dialog"
      >
        {menu && (
          <View style={{ gap: space[3] }}>
            <AppButton label={t('mobileUI.rename')} icon="edit" variant="secondary" onPress={() => { setDialog({ kind: 'rename', item: menu }); setName(menu.title); setError(''); setMenu(null); }} />
            <AppButton label={t('mobileUI.move')} icon="collections" variant="secondary" onPress={() => { setMoving(menu); setError(''); setMenu(null); }} />
            <AppButton label={dict.common.delete} icon="trash" variant="destructive" onPress={() => confirmTrash(menu)} />
          </View>
        )}
        {dialog && (
          <FormSection>
            <AppTextField testID="files-name" label={dialog.kind === 'folder' ? t('mobileUI.folderName') : dict.itemForm.title} value={name} onChangeText={setName} autoFocus autoCapitalize="sentences" returnKeyType="done" onSubmitEditing={() => void saveName()} />
            {!!error && <InlineError>{error}</InlineError>}
            <AppButton testID="files-save-name" label={dict.common.save} disabled={!name.trim()} loading={busy} onPress={() => void saveName()} />
          </FormSection>
        )}
        {moving && (
          <PageSection>
            <Group>
              {[null, ...destinations].map((target, index) => (
                <React.Fragment key={target?.id ?? 'root'}>
                  {index > 0 && <Rule leading />}
                  <SettingsRow testID={`file-move-${target?.id || 'root'}`}
                    label={target?.title || t('mobileUI.allFiles')}
                    icon={<Icon name="collections" size="lg" color={colors.secondary} />}
                    selected={fileParent(moving, items) === (target?.id ?? '')}
                    onPress={busy ? undefined : () => void moveTo(target?.id ?? '')}
                  />
                </React.Fragment>
              ))}
            </Group>
            {busy && <Progress label={dict.common.loading} />}
            {!!error && <InlineError>{error}</InlineError>}
          </PageSection>
        )}
      </BottomSheet>
    </AppPage>
  );
}

function FileVideo({ uri, height }: { uri: string; height: number }) {
  const player = useVideoPlayer(uri, value => { value.loop = false; });
  return <VideoView player={player} style={{ height, width: '100%' }} allowsFullscreen nativeControls contentFit="contain" />;
}

export function FilePreviewScreen({ item }: { item: VaultItem }) {
  const { colors } = useMobileTheme();
  const { t } = useTranslation();
  if (item.fields.storage === 'local-encrypted-v1') return <LocalFilePreview item={item} />;
  const mime = typeof item.fields.mime_type === 'string' ? item.fields.mime_type : '';
  return (
    <AppPage testID="file-preview-screen">
      <PageSection title={item.title} description={[mime, fileSize(item.fields.size_bytes)].filter(Boolean).join(' · ')}>
        {typeof item.fields.notes === 'string' && <Text style={[textStyle.body, { color: colors.text }]}>{item.fields.notes}</Text>}
        <InlineError>{t('mobileUI.fileUnavailable')}</InlineError>
      </PageSection>
    </AppPage>
  );
}
function LocalFilePreview({ item }: { item: VaultItem }) {
  const { colors } = useMobileTheme(); const { t } = useTranslation();
  const [preview, setPreview] = useState<{ uri: string; mime: string } | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const { height } = useWindowDimensions();
  const previewHeight = Math.min(height * 0.48, size.formWidth);
  useEffect(() => {
    let alive = true; let uri = ''; let generation = 0;
    async function load() {
      const current = ++generation; setError('');
      try {
        const value = await openNativeFile(item);
        if (!alive || current !== generation || !isUnlocked()) { await removeFilePreview(value.uri); return; }
        uri = value.uri; setPreview(value);
      } catch { if (alive) setError(t('mobileUI.fileUnavailable')); }
    }
    void load();
    const listener = AppState.addEventListener('change', state => {
      if (state === 'background') { generation++; setPreview(null); if (uri) void removeFilePreview(uri).catch(() => undefined); uri = ''; }
      if (state === 'active' && isUnlocked() && !uri) void load();
    });
    return () => { alive = false; generation++; listener.remove(); if (uri) void removeFilePreview(uri).catch(() => undefined); };
  }, [item.id, retry]);
  return (
    <AppPage testID="file-preview-screen" safeArea="bottom"
      footer={preview && <AppButton testID="file-export" icon="export" label={t('mobileUI.download')} onPress={() => void Sharing.shareAsync(preview.uri, { mimeType: preview.mime }).catch(() => setError(t('mobileUI.fileFailed')))} />}>
      <PageSection title={item.title} description={t('mobileUI.filesOnDevice')}>
        {error ? (
          <>
            <InlineError testID="file-preview-error">{error}</InlineError>
            <AppButton label={t('security.retry')} variant="secondary" onPress={() => { setPreview(null); setRetry(value => value + 1); }} />
          </>
        ) : !preview ? <Progress label={t('common.loading')} /> : (
          preview.mime.startsWith('image/') ? <Image source={{ uri: preview.uri }} resizeMode="contain" style={{ height: previewHeight, width: '100%', borderRadius: radius.surface }} />
            : preview.mime.startsWith('video/') ? <FileVideo uri={preview.uri} height={previewHeight} />
              : <View style={{ minHeight: size.fileRow, alignItems: 'center', justifyContent: 'center' }}><Icon name="genericFile" size="xl" color={colors.muted} /></View>
        )}
      </PageSection>
    </AppPage>
  );
}
