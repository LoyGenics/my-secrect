/**
 * Is this a website address a login can open (example.com, https://a.b/c,
 * localhost:3000)? Same rules as the mobile editor's normalizeWebsite
 * (apps/mobile/src/utils/itemEditor.ts): http(s) only, no credentials in the
 * authority, a dotted host (or localhost / an IPv6 literal), a valid port.
 */
export function isWebsiteAddress(value: string): boolean {
  const input = value.trim();
  if (!input || /[\s\\\u0000-\u001f]/.test(input)) return false;
  const url = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  const authority = /^https?:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(url)?.[1];
  if (!authority || authority.includes('@')) return false;
  const match = /^(\[[a-f\d:.]+\]|[^:]+)(?::(\d{1,5}))?$/i.exec(authority);
  if (!match || (match[2] && (+match[2] < 1 || +match[2] > 65_535))) return false;
  const host = match[1];
  if (host.startsWith('[')) return host.includes(':');
  const labels = host.replace(/\.$/, '').split('.');
  if (!labels.every((label) => /^[\w\p{L}\p{N}](?:[\w\p{L}\p{N}-]*[\w\p{L}\p{N}])?$/u.test(label))) return false;
  return labels.length >= 2 || host.toLowerCase() === 'localhost';
}
