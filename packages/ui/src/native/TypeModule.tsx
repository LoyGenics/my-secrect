import { Image, View } from 'react-native';
import { isItemTypeKey, moduleIcon } from '../modules';
import type { ThemeTokens } from '../tokens';
import { Icon } from './Icon';
import { typeArt } from './illustrations';

export interface NativeTypeModuleProps {
  type: string;
  theme: ThemeTokens;
  /** Edge length in pt (default 44). */
  size?: number;
}

/**
 * The item type's tile (same pastel + picture as web): a rounded square in
 * the type's pastel colour with its 3D picture from 40pt up, and the Lucide
 * glyph below that. Decorative: label the row, not the tile.
 */
export function TypeModule({ type, theme, size = 44 }: NativeTypeModuleProps) {
  const key = isItemTypeKey(type) ? type : 'custom';
  const art = size >= 40;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.32),
        backgroundColor: theme.itemType[key],
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      {art ? (
        <Image source={typeArt[key]} style={{ width: size * 0.9, height: size * 0.9 }} resizeMode="contain" />
      ) : (
        <Icon name={moduleIcon[key]} size={size >= 30 ? 'sm' : 'xs'} color={theme.text.onModule} />
      )}
    </View>
  );
}
