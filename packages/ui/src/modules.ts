/**
 * Item-type tiles: each of the 12 item types owns one Lucide glyph, printed
 * on a soft rounded tile filled with its clay colour (`ThemeTokens.itemType`).
 * Platform-neutral: the web TypeModule and the native TypeModule read the
 * same map, so rail, list, detail and mobile show the identical tile.
 */
import type { ItemTypeKey } from './tokens';
import type { IconName } from './icons';

/** Lucide glyph printed on each tile. */
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
  return Object.prototype.hasOwnProperty.call(moduleIcon, type);
}
