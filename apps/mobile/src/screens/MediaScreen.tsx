import React, { useMemo, useState } from 'react';
import { Image, FlatList, Pressable, Text, View } from 'react-native';
import type { VaultItem } from '../../../../packages/core/src/types';
import { useMobileTheme } from '../theme';
import { Icon, illustrations } from '../../../../packages/ui/src/native';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { Empty, Select } from '../components/mobile-ui';
import { format } from '../../../../packages/i18n/src/index';

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

function formatBytes(n: number, unknown: string): string {
  if (!n) return unknown;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const ICON: Record<Filter, 'collections' | 'media' | 'gallery' | 'documents' | 'custom'> = { all: 'collections', photo: 'media', video: 'gallery', document: 'documents', other: 'custom' };

export default function MediaScreen({ items, onClose, onSelect }: {
  items: VaultItem[]; onClose: () => void; onSelect: (id: string) => void;
}) {
  const { colors, styles } = useMobileTheme();
  const { dict } = useTranslation();
  const t = dict.mobile;
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
  return <View style={styles.screen}>
    <FlatList data={media} keyExtractor={entry => entry.item.id} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 20, paddingBottom: 40, width: '100%', maxWidth: 820, alignSelf: 'center' }}
      ListHeaderComponent={<View style={{ marginBottom: 18 }}>
        <Select testID="media-filter" label={dict.mobileUI.media} value={filter} choices={[
          { value: 'all', label: dict.media.filters.all }, { value: 'photo', label: dict.media.filters.photo },
          { value: 'video', label: dict.media.filters.video }, { value: 'document', label: dict.media.filters.document }, { value: 'other', label: dict.media.filters.misc },
        ]} onChange={value => setFilter(value as Filter)} />
        <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 8 }}>{t.mediaLimits}</Text>
      </View>}
      ListEmptyComponent={<Empty image={illustrations.emptyVault} title={dict.mobileUI.noItems} detail={t.mediaEmpty} />}
      renderItem={({ item: entry }) => <Pressable testID={`media-${entry.item.id}`} accessibilityRole="button" accessibilityLabel={format(t.open, entry.item.title)} onPress={() => onSelect(entry.item.id)} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: colors.card, padding: 16, minHeight: 78, borderBottomWidth: 0.5, borderBottomColor: colors.line }}>
        <Icon name={ICON[entry.kind]} size="xl" color={colors.secondary} />
        <View style={{ flex: 1 }}><Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>{entry.item.title}</Text><Text style={{ color: colors.muted, fontSize: 13, marginTop: 5 }}>{entry.mime} · {formatBytes(entry.size, t.sizeUnknown)}</Text></View>
      </Pressable>}
    />
  </View>;
}
