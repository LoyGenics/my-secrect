import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { MODULE_VIEWBOX, isItemTypeKey, moduleIcon, moduleSilhouette } from '../modules';
import type { ThemeTokens } from '../tokens';
import { Icon } from './Icon';

export interface NativeTypeModuleProps {
  type: string;
  theme: ThemeTokens;
  /** Edge length in pt (default 32). */
  size?: number;
}

/** The item type's module (same silhouette + code colour as web). Decorative: label the row, not the module. */
export function TypeModule({ type, theme, size = 32 }: NativeTypeModuleProps) {
  const key = isItemTypeKey(type) ? type : 'custom';
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }} accessible={false} importantForAccessibility="no-hide-descendants">
      <Svg width={size} height={size} viewBox={MODULE_VIEWBOX} style={{ position: 'absolute' }}>
        <Path d={moduleSilhouette[key]} fill={theme.itemType[key]} stroke="rgba(27, 28, 30, 0.22)" strokeWidth={1} />
      </Svg>
      <Icon name={moduleIcon[key]} size={size >= 44 ? 'lg' : size >= 30 ? 'sm' : 'xs'} color={theme.text.onModule} />
    </View>
  );
}
