import type { VaultItem } from './types';
export const isFile = (item: VaultItem) => item.type === 'media' || item.type === 'document';
export const isFileFolder = (item: VaultItem) => item.type === 'collection' && item.fields.collection_kind === 'files';
export const isFileEntry = (item: VaultItem) => isFile(item) || isFileFolder(item);
export function fileParent(item: VaultItem, items: VaultItem[]): string {
  const id = typeof item.fields.parent_id === 'string' ? item.fields.parent_id : '';
  return items.some(parent => parent.id === id && !parent.deleted_at && isFileFolder(parent)) ? id : '';
}
export function moveFileEntry(item: VaultItem, destination: string, items: VaultItem[], now = new Date().toISOString()): VaultItem {
  if (!isFileEntry(item) || item.deleted_at) throw new Error('invalid file');
  if (destination && !items.some(parent => parent.id === destination && !parent.deleted_at && isFileFolder(parent))) throw new Error('invalid folder');
  const seen = new Set([item.id]); let current = destination;
  while (current) {
    if (seen.has(current)) throw new Error('folder cycle');
    seen.add(current); const parent = items.find(entry => entry.id === current);
    current = parent ? fileParent(parent, items) : '';
  }
  return { ...item, fields: { ...item.fields, parent_id: destination }, updated_at: now };
}
export function availableFileDestinations(item: VaultItem, items: VaultItem[]): VaultItem[] {
  return items.filter(parent => {
    if (!isFileFolder(parent) || parent.deleted_at) return false;
    try { moveFileEntry(item, parent.id, items); return true; } catch { return false; }
  });
}
