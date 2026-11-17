export * from './types';
export * from './sharing';

export function newItemId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return 'item_' + Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function validateItemShape(item: unknown): item is import('./types').VaultItem {
  if (!item || typeof item !== 'object') return false;
  const i = item as Record<string, unknown>;
  return typeof i.id === 'string' && typeof i.type === 'string'
    && typeof i.schema_version === 'number' && typeof i.title === 'string'
    && typeof i.fields === 'object' && Array.isArray(i.tags)
    && Array.isArray(i.relations) && Array.isArray(i.attachments);
}
