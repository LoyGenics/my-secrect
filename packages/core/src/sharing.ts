/**
 * Sharing model — share a vault (or items in it) with another person.
 *
 * Implemented in code (NOT run end-to-end, NOT audited). Deferred by
 * design in the architecture until personal key management is stable:
 * sharing is modelled here so the UI + API have a real shape, but the
 * app must not present sharing as production-ready until the key-exchange
 * protocol (HPKE / verified key establishment) is implemented and tested.
 *
 * How sharing works, cryptographically:
 *  - The sharer wraps the Vault Key (or a per-share Item Key) with the
 *    recipient's public key and stores that as a KeyEnvelope on the
 *    server. The server sees only the envelope + opaque ids — never the
 *    Vault Key, never plaintext.
 *  - The recipient unwraps the envelope with their private key, then
 *    decrypts shared items exactly like their own vault items.
 *  - Revocation removes the envelope and the share record. It does NOT
 *    retroactively erase copies a recipient already decrypted — that
 *    limitation must be shown in the UI. Re-sharing after revocation
 *    requires key rotation (see specs/key-management.md).
 *  - Permission `read` = view + copy. `write` = view + edit shared items.
 *    Neither permission lets the recipient re-share or change the vault
 *    owner's key. `admin` does not exist in v1.
 */

export type SharePermission = 'read' | 'write';
export type ShareStatus = 'active' | 'revoked' | 'pending';

export interface VaultShare {
  id: string; // share_<random>
  vault_id: string;
  owner_id: string; // opaque user id
  recipient_id: string; // opaque user id — server knows the id, not the name
  recipient_label_encrypted: string | null; // display name, encrypted; null = unknown
  permission: SharePermission;
  status: ShareStatus;
  key_envelope_id: string; // id of the KeyEnvelope holding the wrapped Vault Key
  item_ids: string[]; // empty = whole vault; otherwise only these items
  created_at: string;
  revoked_at: string | null;
}

export interface ShareProposal {
  vault_id: string;
  recipient_id: string;
  permission: SharePermission;
  item_ids: string[];
  /**
   * Phase C (H4): REQUIRED. Base64 of the Vault Key (or per-share Item
   * Key) wrapped for the recipient. The server rejects an ACTIVE share
   * without it (Sharing::Create) — a keyless active share can never be
   * decrypted by the recipient.
   *
   * HPKE KEY EXCHANGE IS STILL NOT IMPLEMENTED. This field only carries
   * whatever wrapped key the client supplies; nothing here verifies it
   * was HPKE-wrapped for this recipient's public key. Sharing is NOT
   * production-ready until Phase E/F delivers real HPKE key exchange +
   * recipient key verification. Never present sharing as working
   * end-to-end until then, and never fake the exchange.
   */
  encrypted_key: string;
}

export function validateShareProposal(p: ShareProposal): string | null {
  if (!p.vault_id) return 'vault_id is required';
  if (!p.recipient_id) return 'recipient_id is required';
  if (p.permission !== 'read' && p.permission !== 'write') return 'permission must be read or write';
  if (!Array.isArray(p.item_ids)) return 'item_ids must be an array (empty = whole vault)';
  if (!p.encrypted_key || typeof p.encrypted_key !== 'string' || p.encrypted_key.trim() === '') {
    return 'encrypted_key is required for an active share (wrapped Vault Key for the recipient; HPKE exchange not yet implemented)';
  }
  return null;
}

/**
 * An ACTIVE share is only usable if it has a key envelope to unwrap.
 * Returns an error string when the share must not be treated as active,
 * or null when it is usable (key present — still NOT proof of real HPKE).
 */
export function validateShareForActivation(share: VaultShare): string | null {
  if (share.status !== 'active') return `share is ${share.status}, not active`;
  if (!share.key_envelope_id) return 'active share has no key envelope — recipient cannot decrypt';
  return null;
}

export function canRead(share: VaultShare): boolean {
  return share.status === 'active' && (share.permission === 'read' || share.permission === 'write');
}

export function canWrite(share: VaultShare): boolean {
  return share.status === 'active' && share.permission === 'write';
}

export function isWholeVaultShare(share: VaultShare): boolean {
  return share.item_ids.length === 0;
}

/** Revoke a share. Returns the revoked copy; the caller must also delete
 *  the KeyEnvelope on the server and record an audit event. Revocation
 *  does NOT erase copies already decrypted by the recipient. */
export function revokeShare(share: VaultShare, now: string = new Date().toISOString()): VaultShare {
  if (share.status === 'revoked') return share;
  return { ...share, status: 'revoked', revoked_at: now };
}

export function newShareId(randomBytes: (n: number) => Uint8Array): string {
  const b = randomBytes(12);
  return 'share_' + Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}
