/**
 * autofill_index rows (specs/mobile-local-store.md §2): title, username
 * and host for live login / passkey items only. Never a password, TOTP
 * secret, note or key. The credential providers read this table to list
 * candidates before any biometric prompt.
 */
import type { VaultItem } from '../../../../packages/core/src/types';
import type { AutofillEntry } from './vaultStore';

/**
 * Host as the providers' DomainMatching.normalizeHost sees it: no
 * scheme, userinfo, port, path or leading "www.", lower-case. Parsed by
 * hand because React Native's URL polyfill does not implement hostname.
 */
export function hostForIndex(value: unknown): string {
  if (typeof value !== 'string') return '';
  let s = value.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\/\//, '');
  s = s.split(/[/?#]/, 1)[0] ?? '';
  s = s.slice(s.lastIndexOf('@') + 1);
  if (s.startsWith('[')) s = s.slice(0, s.indexOf(']') + 1);
  else s = s.replace(/:\d*$/, '');
  return s.replace(/^www\./, '').replace(/\.$/, '');
}

export function autofillEntryFor(item: VaultItem): AutofillEntry | null {
  if (item.deleted_at) return null;
  if (item.type !== 'login' && item.type !== 'passkey') return null;
  const username = typeof item.fields.username === 'string' ? item.fields.username : '';
  const host = hostForIndex(item.type === 'login' ? item.fields.url : item.fields.rp_id);
  return { id: item.id, title: item.title, username, host, type: item.type };
}

export function autofillIndexFor(items: readonly VaultItem[]): AutofillEntry[] {
  return items.map(autofillEntryFor).filter((e): e is AutofillEntry => e !== null);
}
