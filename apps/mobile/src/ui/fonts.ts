import { Platform } from 'react-native';
import { fontFamily } from './tokens';

/** Be Vietnam Pro (SIL OFL 1.1, assets/fonts/OFL.txt): latin, latin-ext and Vietnamese in each face. */
export const fontAssets = {
  [fontFamily.regular]: require('../../assets/fonts/BeVietnamPro_400Regular.ttf'),
  [fontFamily.medium]: require('../../assets/fonts/BeVietnamPro_500Medium.ttf'),
  [fontFamily.semibold]: require('../../assets/fonts/BeVietnamPro_600SemiBold.ttf'),
  [fontFamily.bold]: require('../../assets/fonts/BeVietnamPro_700Bold.ttf'),
};

/** Secrets and codes use the platform monospace. */
export const monoFamily = Platform.select({ ios: 'Menlo', default: 'monospace' });
