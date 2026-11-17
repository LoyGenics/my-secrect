/**
 * Item-type modules: each of the 12 item types owns one silhouette (shape
 * encodes type) drawn on a 32x32 grid, filled with its code colour
 * (`ThemeTokens.itemType`). Platform-neutral path data: the web TypeModule
 * renders it as inline SVG, the native TypeModule through react-native-svg,
 * so rail, list, detail and mobile show the identical module.
 */
import type { ItemTypeKey } from './tokens';
import type { IconName } from './icons';

export const MODULE_VIEWBOX = '0 0 32 32';

export const moduleSilhouette: Record<ItemTypeKey, string> = {
  // keycap: rounded square
  login: 'M8 3h16a5 5 0 0 1 5 5v16a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5V8a5 5 0 0 1 5-5z',
  // round token
  passkey: 'M16 2.5a13.5 13.5 0 1 1 0 27a13.5 13.5 0 1 1 0-27z',
  // stadium
  bank_account: 'M11 6h10a10 10 0 0 1 0 20H11a10 10 0 0 1 0-20z',
  // landscape card
  card: 'M5 7h22a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V10a3 3 0 0 1 3-3z',
  // badge with lanyard notch
  identity: 'M4 6a3 3 0 0 1 3-3h6a3 3 0 0 0 6 0h6a3 3 0 0 1 3 3v20a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z',
  // flat-top hexagon
  ssh_key: 'M9 3h14l7 13-7 13H9L2 16z',
  // octagon
  api_key: 'M11 2h10l9 9v10l-9 9H11l-9-9V11z',
  // pad with a dog-eared lower corner
  secure_note: 'M6 3h20a3 3 0 0 1 3 3v15l-8 8H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z',
  // portrait sheet, folded upper corner
  document: 'M7 2h12l8 8v17a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3z',
  // diamond
  media: 'M16 1.5L30.5 16 16 30.5 1.5 16z',
  // folder with tab
  collection: 'M3 8a3 3 0 0 1 3-3h7l3 3h10a3 3 0 0 1 3 3v15a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z',
  // ticket with side notches
  custom: 'M3 6a3 3 0 0 1 3-3h20a3 3 0 0 1 3 3v6a4 4 0 0 0 0 8v6a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-6a4 4 0 0 0 0-8z',
};

/** Lucide glyph printed on each module. */
export const moduleIcon: Record<ItemTypeKey, IconName> = {
  login: 'credentials',
  passkey: 'passkey',
  bank_account: 'finance',
  card: 'card',
  identity: 'identity',
  ssh_key: 'developer',
  api_key: 'apiKey',
  secure_note: 'notes',
  document: 'documents',
  media: 'media',
  collection: 'collections',
  custom: 'custom',
};

/** Categories (desktop rail groups) reuse the module of their lead type. */
export const categoryModule: Record<string, ItemTypeKey> = {
  credentials: 'login',
  finance: 'bank_account',
  identity: 'identity',
  developer: 'ssh_key',
  notes: 'secure_note',
  media: 'media',
  documents: 'document',
  collections: 'collection',
};

export function isItemTypeKey(type: string): type is ItemTypeKey {
  return Object.prototype.hasOwnProperty.call(moduleSilhouette, type);
}
