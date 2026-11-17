import React, { useMemo, useState } from 'react';
import { Image, FlatList, Pressable, Text, View } from 'react-native';
import type { VaultItem } from '../../../../packages/core/src/types';
import { useMobileTheme } from '../theme';
import { Icon, illustrations, typeArt } from '../../../../packages/ui/src/native';

/**
 * Media gallery (mobile) — encrypted-manifest view only.
 *
 * Honest limits, shown in the UI itself:
 *  - A media/document item stores ONLY metadata here (file name, MIME
 *    type, size, SHA-256, blob id). File bytes are NOT stored in this
 *    local prototype, so there is no download and no thumbnail: a tile
 *    that showed a thumbnail would be fake. Thumbnails must be generated
 *    and encrypted on-device before upload (see the desktop MediaView
 *    notes) — until that pipeline exists, tiles show metadata only.
 *  - Manifest status is 'unknown' for every item: no manifest has been
 *    synced to this device, and 'unknown' means exactly that — not an
 *    error, not verified.
 *  - Video range playback: seeking maps to encrypted chunks, so playback
 *    never needs the whole file first. No player is wired yet because
 *    there are no bytes to play.
 */

type Filter = 'all' | 'photo' | 'video' | 'document' | 'other';

function kindOf(mime: string): Filter {
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'document';
  return 'other';
}

function formatBytes(n: number): string {
  if (!n) return 'size unknown';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const ICON: Record<Filter, 'collections' | 'media' | 'gallery' | 'documents' | 'custom'> = { all: 'collections', photo: 'media', video: 'gallery', document: 'documents', other: 'custom' };

export default function MediaScreen({ items, onClose, onSelect }: {
  items: VaultItem[]; onClose: () => void; onSelect: (id: string) => void;
}) {
  const { colors, styles } = useMobileTheme();
  const [filter, setFilter] = useState<Filter>('all');
  const media = useMemo(() => {
    const list = items
      .filter((i) => i.type === 'media' || i.type === 'document')
      .map((item) => {
        const f = item.fields as Record<string, unknown>;
        const mime = typeof f.mime_type === 'string' ? f.mime_type : 'application/octet-stream';
        const size = typeof f.size_bytes === 'number' ? f.size_bytes : typeof f.size === 'string' ? Number(f.size) || 0 : 0;
        return { item, mime, size, kind: kindOf(mime), sha: typeof f.sha256 === 'string' ? f.sha256 : '' };
      });
    return filter === 'all' ? list : list.filter((m) => m.kind === filter);
  }, [items, filter]);
  const chip = (key: Filter, label: string) => (
    <Pressable key={key} testID={`media-filter-${key}`} accessibilityLabel={`Filter ${label}`} onPress={() => setFilter(key)} style={{ backgroundColor: filter === key ? colors.accent : colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, marginRight: 8, marginBottom: 8 }}>
      <Text style={{ color: filter === key ? colors.onAccent : colors.text, fontSize: 13, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={styles.screen}>
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
        <Pressable testID="media-back" accessibilityLabel="Back to vault" onPress={onClose} hitSlop={10} style={{ alignSelf: 'flex-start', paddingVertical: 8 }}><Text style={{ color: '#A5B4FC', fontSize: 15 }}>‹ Back</Text></Pressable>
        <Text style={styles.title}>Media gallery</Text>
        <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 6 }}>
          Encrypted manifests only — file bytes are not stored in this prototype, so there are no thumbnails or downloads yet. Thumbnails must be generated and encrypted on this device before upload.
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 12 }}>
          {chip('all', 'All')}{chip('photo', 'Photos')}{chip('video', 'Videos')}{chip('document', 'Documents')}{chip('other', 'Other')}
        </View>
      </View>
      {media.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <Image source={illustrations.emptyVault} style={{ width: 136, height: 136 }} accessibilityIgnoresInvertColors />
          <Text style={{ color: colors.muted, fontSize: 14, textAlign: 'center', marginTop: 12 }}>No media or documents yet. Add a media item — only its name, type, size and SHA-256 hash are kept.</Text>
        </View>
      ) : (
        <FlatList
          data={media}
          keyExtractor={(m) => m.item.id}
          contentContainerStyle={{ padding: 16 }}
          renderItem={({ item: m }) => (
            <Pressable testID={`media-${m.item.id}`} accessibilityLabel={`Open ${m.item.title}`} onPress={() => onSelect(m.item.id)} style={{ backgroundColor: colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ marginRight: 12 }}><Icon name={ICON[m.kind]} size="xl" color={colors.text} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>{m.item.title}</Text>
                  <Text style={{ color: colors.muted, fontSize: 13, marginTop: 2 }}>{m.mime} · {formatBytes(m.size)}</Text>
                  <Text style={{ color: colors.faint, fontSize: 12, marginTop: 2 }}>Manifest: unknown (not synced) · Thumbnail encrypted</Text>
                  {m.sha ? <Text style={{ color: colors.faint, fontSize: 11, marginTop: 2 }} numberOfLines={1}>SHA-256: {m.sha.slice(0, 32)}…</Text> : null}
                </View>
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}
