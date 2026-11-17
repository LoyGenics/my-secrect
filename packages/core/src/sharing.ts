/**
 * Sharing model — share a vault (or items in it) with another person.
 *
 * Implemented in code (NOT run end-to-end, NOT audited). Deferred by
 * design in the architecture until personal key management is stable:
 * sharing is modelled here so the UI + API have a real shape. Sharing is
 * not live: this module does not implement HPKE, crypto_box, or any wrap.
 * A proposal can be recorded as pending without encrypted_key.
 * Activation fails closed because no verified wrap exists.
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
   * Optional on a pending proposal. When present it is an unverified
   * opaque blob, not proof of a wrap. Omitted, null, or blank is valid
   * for a proposal: the proposal stays pending and is not activated.
   * Activation is a separate check and fails closed — no recipient
   * public key, HPKE, or crypto_box verification exists. Sharing is not live.
   */
  encrypted_key?: string | null;
}

/** Pending-proposal check. encrypted_key is optional and is never treated
 *  as a verified wrap. Returns an error string, or null when the proposal
 *  may be recorded as pending. */
export function validateShareProposal(p: ShareProposal): string | null {
  if (!p.vault_id) return 'vault_id is required';
  if (!p.recipient_id) return 'recipient_id is required';
  if (p.permission !== 'read' && p.permission !== 'write') return 'permission must be read or write';
  if (!Array.isArray(p.item_ids)) return 'item_ids must be an array (empty = whole vault)';
  if (p.encrypted_key != null && typeof p.encrypted_key !== 'string') {
    return 'encrypted_key must be a string when provided';
  }
  return null;
}

/** Record a proposal as pending. Never returns status active, even when
 *  encrypted_key is present — that blob is not a verified wrap. Throws the
 *  proposal validation error; callers must surface it. */
export function recordPendingProposal(
  proposal: ShareProposal,
  meta: { id: string; owner_id: string; created_at: string },
): VaultShare {
  const err = validateShareProposal(proposal);
  if (err) throw new Error(err);
  return {
    id: meta.id,
    vault_id: proposal.vault_id,
    owner_id: meta.owner_id,
    recipient_id: proposal.recipient_id,
    recipient_label_encrypted: null,
    permission: proposal.permission,
    status: 'pending',
    key_envelope_id: '',
    item_ids: proposal.item_ids.slice(),
    created_at: meta.created_at,
    revoked_at: null,
  };
}

/**
 * Activation requires a verified wrap. Verification does not exist, so
 * this always fails closed. A key envelope id or any opaque blob is not
 * proof the share can be activated. Never returns null.
 */
export function validateShareForActivation(share: VaultShare): string | null {
  const id = share.id ? ` ${share.id}` : '';
  return `activation rejected for share${id}: no verified key wrap exists`;
}

export function canRead(share: VaultShare): boolean {
  // No verified wrap exists, so validateShareForActivation always rejects.
  // A forged status of 'active' must not grant access.
  if (validateShareForActivation(share) !== null) return false;
  return share.status === 'active' && (share.permission === 'read' || share.permission === 'write');
}

export function canWrite(share: VaultShare): boolean {
  if (validateShareForActivation(share) !== null) return false;
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
