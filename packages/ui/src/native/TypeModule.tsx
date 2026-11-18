import { View } from 'react-native';
import { isItemTypeKey, moduleIcon } from '../modules';
import type { ThemeTokens } from '../tokens';
import { Icon } from './Icon';

export interface NativeTypeModuleProps {
  type: string;
  theme: ThemeTokens;
  /** Edge length in pt (default 32). */
  size?: number;
}

/** The item type's tile (same glyph + clay colour as web). Decorative: label the row, not the tile. */
export function TypeModule({ type, theme, size = 32 }: NativeTypeModuleProps) {
  const key = isItemTypeKey(type) ? type : 'custom';
  return (
    <View
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), backgroundColor: theme.itemType[key], alignItems: 'center', justifyContent: 'center' }}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <Icon name={moduleIcon[key]} size={size >= 44 ? 'lg' : size >= 30 ? 'sm' : 'xs'} color={theme.text.onModule} />
    </View>
  );
}
