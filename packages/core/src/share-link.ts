/** Expiring, read-only item snapshots. Protocol: specs/share-links.md.
 * The random key travels only in the URL fragment, never to the API.
 */
import sodium from 'libsodium-wrappers-sumo';
import { fromBase64, fromBase64Url, sodiumReady, toBase64, toBase64Url } from '../../crypto-adapters/src/index';
import { assertValidItemContent } from './sharing';
import type { VaultItem } from './types';

interface LinkSodium {
  randombytes_buf(n: number): Uint8Array;
  from_string(s: string): Uint8Array;
  to_string(b: Uint8Array): string;
  crypto_aead_xchacha20poly1305_ietf_encrypt(m: Uint8Array, ad: Uint8Array, unused: null, nonce: Uint8Array, key: Uint8Array): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_decrypt(unused: null, c: Uint8Array, ad: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
}
const na = sodium as unknown as LinkSodium;
export const SHARE_LINK_VERSION = 1;
export const SHARE_LINK_TTLS = [3600, 86400, 604800] as const;
const ID = /^[A-Za-z0-9_-]{32}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const PRIVATE_FIELDS = new Set(['password_history', 'revisions', 'archived', 'parent_id']);
export interface ShareLinkRecord { id: string; format_version: number; expires_at: string; encrypted_payload: string }
export class ShareLinkError extends Error {
  constructor(readonly code: 'invalid' | 'expired' | 'unsupported') { super(code); this.name = 'ShareLinkError'; }
}
function context(record: Pick<ShareLinkRecord, 'id' | 'format_version' | 'expires_at'>): Uint8Array {
  if (!ID.test(record.id) || record.format_version !== 1 || new Date(record.expires_at).toISOString() !== record.expires_at) throw new ShareLinkError('invalid');
  return na.from_string(`my-secrect:share-link:v1:${record.id}:${record.expires_at}`);
}
export function shareLinkSnapshot(item: VaultItem): VaultItem {
  if (['media', 'document', 'collection'].includes(item.type)) throw new ShareLinkError('unsupported');
  const snapshot: VaultItem = {
    id: 'shared-copy', type: item.type, schema_version: item.schema_version, title: item.title,
    fields: Object.fromEntries(Object.entries(item.fields).filter(([name]) => !PRIVATE_FIELDS.has(name))),
    tags: [], relations: [], attachments: [], created_at: item.created_at, updated_at: item.updated_at,
  };
  assertValidItemContent(snapshot);
  return snapshot;
}
export async function createShareLink(item: VaultItem, ttl: number, now = Date.now()): Promise<{ record: ShareLinkRecord; secret: string }> {
  await sodiumReady;
  if (!SHARE_LINK_TTLS.includes(ttl as typeof SHARE_LINK_TTLS[number])) throw new ShareLinkError('invalid');
  const record = { id: toBase64Url(na.randombytes_buf(24)), format_version: SHARE_LINK_VERSION, expires_at: new Date(now + ttl * 1000).toISOString(), encrypted_payload: '' };
  const key = na.randombytes_buf(32); const nonce = na.randombytes_buf(24);
  const plaintext = na.from_string(JSON.stringify(shareLinkSnapshot(item)));
  try {
    const cipher = na.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, context(record), null, nonce, key);
    const packed = new Uint8Array(nonce.length + cipher.length); packed.set(nonce); packed.set(cipher, nonce.length);
    record.encrypted_payload = toBase64(packed);
    return { record, secret: toBase64Url(key) };
  } finally { key.fill(0); plaintext.fill(0); }
}
export async function openShareLink(record: ShareLinkRecord, secret: string, now = Date.now()): Promise<VaultItem> {
  await sodiumReady;
  let key: Uint8Array | undefined; let plain: Uint8Array | undefined;
  try {
    const ad = context(record);
    if (!SECRET.test(secret)) throw new ShareLinkError('invalid');
    if (Date.parse(record.expires_at) <= now) throw new ShareLinkError('expired');
    if (record.encrypted_payload.length > 350000) throw new ShareLinkError('invalid');
    key = fromBase64Url(secret);
    const packed = fromBase64(record.encrypted_payload);
    if (key.length !== 32 || packed.length < 40) throw new ShareLinkError('invalid');
    plain = na.crypto_aead_xchacha20poly1305_ietf_decrypt(null, packed.subarray(24), ad, packed.subarray(0,24), key);
    const item = JSON.parse(na.to_string(plain));
    if (!item || typeof item.title !== 'string' || item.title.length > 10000 || typeof item.fields !== 'object' || item.fields === null || Array.isArray(item.fields)) throw new ShareLinkError('invalid');
    // Rebuild the public shape; private history and graph never reach the viewer.
    return shareLinkSnapshot(item as VaultItem);
  } catch (e) { if (e instanceof ShareLinkError) throw e; throw new ShareLinkError('invalid'); }
  finally { key?.fill(0); plain?.fill(0); }
}
/** User-configured web origin. Never take a key destination from an API response. */
export function shareLinkURL(origin: string, id: string, secret: string): string {
  const url = new URL(origin);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) || url.username || url.password || !ID.test(id) || !SECRET.test(secret)) throw new ShareLinkError('invalid');
  return `${url.origin}/share/${id}#k=${secret}`;
}
