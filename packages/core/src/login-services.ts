import type { VaultItem } from './types';

const POPULAR_SERVICES = ['Google', 'Apple', 'Microsoft', 'Facebook', 'GitHub', 'Instagram', 'LinkedIn', 'Netflix', 'TikTok', 'Zalo'];

export function loginServiceNames(items: readonly VaultItem[], current = ''): string[] {
  const names = new Map<string, string>();
  for (const name of [...POPULAR_SERVICES, ...items.filter((item) => item.type === 'login').map((item) => item.title), current]) {
    const trimmed = name.trim();
    const key = trimmed.toLowerCase();
    if (key && !names.has(key)) names.set(key, trimmed);
  }
  // Keep the selected spelling visible when editing a legacy item.
  if (current.trim()) names.set(current.trim().toLowerCase(), current.trim());
  return [...names.values()];
}
