import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, AppState, FlatList, Image, Modal, Pressable, SafeAreaView, Text, View } from 'react-native';
import * as Documents from 'expo-document-picker';
import * as Photos from 'expo-image-picker';
import * as FS from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { VideoView, useVideoPlayer } from 'expo-video';
import { Check, ChevronRight, File, FileImage, FileText, Film, Folder, FolderPlus, MoreHorizontal, Upload, X } from 'lucide-react-native';
import type { VaultItem } from '../../../../packages/core/src/types';
import { availableFileDestinations, fileParent, isFileEntry, isFileFolder, moveFileEntry } from '../../../../packages/core/src/files';
import { libsodiumAdapter } from '../../../../packages/crypto-adapters/src/index';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { illustrations } from '../../../../packages/ui/src/native';
import { Action, Empty, Page, Row } from '../components/mobile-ui';
import Field from '../components/Field';
import { useMobileTheme } from '../theme';
import { importNativeFile, openNativeFile } from '../storage/localFiles';
import { isUnlocked } from '../vault';

function id() {
  const bytes = libsodiumAdapter.randomBytes(16); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function size(value: unknown): string {
  const bytes = Number(value) || 0;
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
function FileGlyph({ item }: { item: VaultItem }) {
  const { colors } = useMobileTheme();
  const mime = String(item.fields.mime_type ?? '');
  const Glyph = isFileFolder(item) ? Folder : mime.startsWith('image/') ? FileImage : mime.startsWith('video/') ? Film : FileText;
  return <View style={{ width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: colors.surface2 }}><Glyph size={24} strokeWidth={1.7} color={colors.secondary} /></View>;
}
interface Props {
  items: VaultItem[]; folderId?: string; onSave: (item: VaultItem) => Promise<void>; onDelete: (id: string) => Promise<void>;
  onOpenFolder: (id: string) => void; onOpenFile: (id: string) => void;
}
export default function FilesScreen({ items, folderId = '', onSave, onDelete, onOpenFolder, onOpenFile }: Props) {
  const { colors, styles } = useMobileTheme(); const { t, dict } = useTranslation();
  const [busy, setBusy] = useState(false); const [progress, setProgress] = useState(0); const [error, setError] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'folder' | 'rename'; item?: VaultItem } | null>(null);
  const [name, setName] = useState(''); const [moving, setMoving] = useState<VaultItem | null>(null);
  const entries = items.filter(item => isFileEntry(item) && !item.deleted_at && fileParent(item, items) === folderId).sort((a,b) => Number(isFileFolder(b)) - Number(isFileFolder(a)) || a.title.localeCompare(b.title));
  const destinations = moving ? availableFileDestinations(moving, items) : [];
  async function importAssets(assets: Array<{ uri: string; name?: string; size?: number; mimeType?: string }>) {
    setBusy(true); setError('');
    try {
      for (const asset of assets) {
        const info = await FS.getInfoAsync(asset.uri);
        if (!info.exists || info.isDirectory) throw new Error('unreadable');
        try {
          const item = await importNativeFile({ uri: asset.uri, name: asset.name || `File-${Date.now()}`, size: asset.size ?? info.size, mimeType: asset.mimeType || 'application/octet-stream' }, folderId, setProgress);
          await onSave(item);
        } finally {
          // Only picker-created cache copies, never a user's original file.
          if (FS.cacheDirectory && asset.uri.startsWith(FS.cacheDirectory)) await FS.deleteAsync(asset.uri, { idempotent: true });
        }
      }
    } catch (e) { setError(t(e instanceof Error && e.message === 'file_size' ? 'mobileUI.fileTooLarge' : 'mobileUI.uploadFailed')); }
    finally { setBusy(false); setProgress(0); }
  }
  async function chooseFiles() {
    try {
      const result = await Documents.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: '*/*' });
      if (!result.canceled) await importAssets(result.assets);
    } catch { setError(t('mobileUI.uploadFailed')); }
  }
  async function choosePhotos() {
    try {
      const result = await Photos.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, quality: 1 });
      if (!result.canceled) await importAssets(result.assets.map(asset => ({ uri: asset.uri, name: asset.fileName || `${asset.type === 'video' ? 'Video' : 'Photo'}-${Date.now()}.${asset.type === 'video' ? 'mp4' : 'jpg'}`, size: asset.fileSize, mimeType: asset.mimeType || (asset.type === 'video' ? 'video/mp4' : 'image/jpeg') })));
    } catch { setError(t('mobileUI.uploadFailed')); }
  }
  function uploadMenu() {
    Alert.alert(t('mobileUI.upload'), undefined, [{ text: t('mobileUI.upload'), onPress: () => void chooseFiles() }, { text: t('mobileUI.photos'), onPress: () => void choosePhotos() }, { text: dict.common.cancel, style: 'cancel' }]);
  }
  async function saveName() {
    if (!name.trim() || !dialog) return;
    setBusy(true); setError('');
    try {
      const now = new Date().toISOString();
      const item: VaultItem = dialog.item ? { ...dialog.item, title: name.trim(), updated_at: now } : { id: id(), type: 'collection', schema_version: 1, title: name.trim(), fields: { collection_kind: 'files', parent_id: folderId }, relations: [], attachments: [], tags: [], favorite: false, created_at: now, updated_at: now };
      await onSave(item); setDialog(null); setName('');
    } catch { setError(t('mobileUI.saveFailed')); } finally { setBusy(false); }
  }
  function actions(item: VaultItem) {
    Alert.alert(item.title, undefined, [
      { text: t('mobileUI.rename'), onPress: () => { setName(item.title); setDialog({ kind: 'rename', item }); } },
      { text: t('mobileUI.move'), onPress: () => setMoving(item) },
      { text: dict.common.delete, style: 'destructive', onPress: () => {
        if (isFileFolder(item) && items.some(child => !child.deleted_at && fileParent(child, items) === item.id)) { Alert.alert(t('mobileUI.folderNotEmpty')); return; }
        Alert.alert(dict.mobile.moveToTrashTitle, undefined, [{ text: dict.common.cancel, style: 'cancel' }, { text: dict.common.delete, style: 'destructive', onPress: () => void onDelete(item.id).catch(() => setError(t('mobileUI.saveFailed'))) }]);
      } }, { text: dict.common.cancel, style: 'cancel' },
    ]);
  }
  return <View style={styles.screen}>
    <FlatList data={entries} keyExtractor={item => item.id} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 20, paddingTop: 8, paddingBottom: 40, width: '100%', maxWidth: 820, alignSelf: 'center' }}
      ListHeaderComponent={<View style={{ marginBottom: 18 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Pressable testID="files-upload" accessibilityRole="button" accessibilityLabel={t('mobileUI.upload')} disabled={busy} onPress={uploadMenu} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, opacity: busy ? 0.5 : 1 }}><Upload size={20} color={colors.link} /><Text style={{ color: colors.link, fontSize: 16, fontWeight: '600' }}>{t('mobileUI.upload')}</Text></Pressable>
          <Pressable testID="files-new-folder" accessibilityRole="button" accessibilityLabel={t('mobileUI.newFolder')} disabled={busy} onPress={() => { setName(''); setDialog({ kind: 'folder' }); }} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8 }}><FolderPlus size={20} color={colors.link} /><Text style={{ color: colors.link, fontSize: 16, fontWeight: '600' }}>{t('mobileUI.newFolder')}</Text></Pressable>
        </View>
        {busy && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 14 }}><ActivityIndicator color={colors.accent} /><Text style={{ color: colors.muted, fontSize: 14 }}>{t('mobileUI.uploading', progress)}</Text></View>}
        {!!error && <Text testID="files-error" accessibilityRole="alert" style={{ color: colors.dangerText, fontSize: 14, lineHeight: 21, paddingVertical: 12 }}>{error}</Text>}
      </View>}
      ListEmptyComponent={<Empty image={illustrations.emptyVault} title={t('mobileUI.filesEmpty')} detail={t('mobileUI.filesEmptyBody')} />}
      renderItem={({ item }) => <View style={{ backgroundColor: colors.card, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 0.5, borderBottomColor: colors.line }}>
        <Pressable testID={`file-entry-${item.id}`} accessibilityRole="button" accessibilityLabel={item.title} onLongPress={() => actions(item)} onPress={() => isFileFolder(item) ? onOpenFolder(item.id) : onOpenFile(item.id)} style={{ flex: 1, minHeight: 78, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 13 }}>
          <FileGlyph item={item} /><View style={{ flex: 1, minWidth: 0 }}><Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }} numberOfLines={2}>{item.title}</Text><Text style={{ color: colors.muted, fontSize: 13, marginTop: 4 }}>{isFileFolder(item) ? t('mobileUI.itemCount', items.filter(child => fileParent(child, items) === item.id && !child.deleted_at).length) : size(item.fields.size_bytes)}</Text></View>
        </Pressable>
        <Pressable testID={`file-options-${item.id}`} accessibilityRole="button" accessibilityLabel={`${t('mobileUI.fileActions')}: ${item.title}`} onPress={() => actions(item)} style={{ width: 48, height: 54, alignItems: 'center', justifyContent: 'center' }}><MoreHorizontal size={22} color={colors.muted} /></Pressable>
      </View>}
    />
    <Modal visible={!!dialog || !!moving} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { if (!busy) { setDialog(null); setMoving(null); } }}>
      <SafeAreaView style={styles.screen}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: 16 }}><Text accessibilityRole="header" style={{ color: colors.text, fontSize: 20, fontWeight: '600', flex: 1 }}>{moving ? t('mobileUI.moveTo') : dialog?.kind === 'folder' ? t('mobileUI.newFolder') : t('mobileUI.rename')}</Text><Pressable testID="files-dialog-close" accessibilityRole="button" accessibilityLabel={dict.common.close} disabled={busy} onPress={() => { setMoving(null); setDialog(null); }} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><X size={22} color={colors.link} /></Pressable></View>
        {moving ? <FlatList data={[null, ...destinations]} keyExtractor={item => item?.id || 'root'} contentContainerStyle={{ padding: 20 }} renderItem={({ item: target }) => <Row testID={`file-move-${target?.id || 'root'}`} label={target?.title || t('mobileUI.allFiles')} icon={<Folder size={22} color={colors.secondary} />} onPress={() => {
          const source = moving; setMoving(null); void onSave(moveFileEntry(source, target?.id || '', items)).catch(() => setError(t('mobileUI.saveFailed')));
        }}>{fileParent(moving, items) === (target?.id || '') ? <Check size={20} color={colors.link} /> : <ChevronRight size={18} color={colors.muted} />}</Row>} /> : <Page>
          <Field testID="files-name" label={dialog?.kind === 'folder' ? t('mobileUI.folderName') : dict.itemForm.title} value={name} onChangeText={setName} autoFocus autoCapitalize="sentences" />
          <Action testID="files-save-name" label={dict.common.save} disabled={busy || !name.trim()} onPress={() => void saveName()} />
        </Page>}
      </SafeAreaView>
    </Modal>
  </View>;
}
function FileVideo({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, value => { value.loop = false; });
  return <VideoView player={player} style={{ height: 320, width: '100%' }} allowsFullscreen nativeControls contentFit="contain" />;
}
export function FilePreviewScreen({ item }: { item: VaultItem }) {
  const { colors } = useMobileTheme(); const { t } = useTranslation();
  const [preview, setPreview] = useState<{ uri: string; mime: string } | null>(null); const [error, setError] = useState('');
  useEffect(() => {
    let alive = true; let uri = ''; let generation = 0;
    async function load() {
      const current = ++generation; setError('');
      try {
        const value = await openNativeFile(item);
        if (!alive || current !== generation || !isUnlocked()) { await FS.deleteAsync(value.uri, { idempotent: true }); return; }
        uri = value.uri; setPreview(value);
      } catch { if (alive) setError(t('mobileUI.fileUnavailable')); }
    }
    void load();
    const listener = AppState.addEventListener('change', state => {
      if (state === 'background') { generation++; setPreview(null); if (uri) void FS.deleteAsync(uri, { idempotent: true }); }
      if (state === 'active' && isUnlocked()) void load();
    });
    return () => { alive = false; generation++; listener.remove(); if (uri) void FS.deleteAsync(uri, { idempotent: true }); };
  }, [item.id]);
  return <Page>
    <Text style={{ color: colors.text, fontSize: 23, lineHeight: 30, fontWeight: '600', marginBottom: 20 }}>{item.title}</Text>
    {error ? <Empty image={illustrations.error} title={error} /> : !preview ? <ActivityIndicator color={colors.accent} style={{ marginVertical: 40 }} /> : <>
      {preview.mime.startsWith('image/') ? <Image source={{ uri: preview.uri }} resizeMode="contain" style={{ height: 380, width: '100%', borderRadius: 12, marginBottom: 24 }} /> : preview.mime.startsWith('video/') ? <FileVideo uri={preview.uri} /> : <View style={{ height: 180, alignItems: 'center', justifyContent: 'center' }}><File size={64} color={colors.muted} /></View>}
      <View style={{ marginTop: 24 }}><Action testID="file-export" label={t('mobileUI.download')} onPress={() => void Sharing.shareAsync(preview.uri, { mimeType: preview.mime }).catch(() => setError(t('mobileUI.fileFailed')))} /></View>
    </>}
  </Page>;
}
