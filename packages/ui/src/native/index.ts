/**
 * React Native entry of the design system: tokens, icon vocabulary, the
 * Lucide icon wrapper, item-type modules and 3D illustrations. Never
 * import the web components (DOM) from React Native.
 */
export * from '../tokens';
export * from '../icons';
export * from '../modules';
export { Icon, type NativeIconName, type NativeIconProps } from './Icon';
export { TypeModule, type NativeTypeModuleProps } from './TypeModule';
export { illustrations, mascot, typeArt, type NativeIllustrationName, type NativeMascotName } from './illustrations';
