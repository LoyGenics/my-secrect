import { useState } from 'react';
import type { VaultShare, SharePermission } from '../../../packages/core/src/sharing';
import { canRead, canWrite, isWholeVaultShare, validateShareProposal } from '../../../packages/core/src/sharing';

/**
 * SharesView — NEW FILE, does not modify App.tsx (another agent owns it).
 * App.tsx can render <SharesView shares={...} onCreate={...} onRevoke={...} />
 * when it chooses; this component is complete on its own.
 *
 * Honest limits, shown in the UI itself:
 *  - Sharing is modelled, not production-ready: the key-exchange protocol
 *    (HPKE / verified key establishment) is not implemented yet, so the
 *    create form collects the proposal only — the caller must wire the
 *    envelope exchange before any real share is created.
 *  - Revocation removes the envelope + share record. It does NOT erase
 *    copies a recipient already decrypted. That is stated next to the
 *    Revoke button, not hidden in docs.
 */

export interface SharesViewProps {
  shares: VaultShare[];
  onCreate?: (proposal: { recipient_id: string; permission: SharePermission; item_ids: string[] }) => void;
  onRevoke?: (share: VaultShare) => void;
}

export default function SharesView({ shares, onCreate, onRevoke }: SharesViewProps) {
  const [recipientId, setRecipientId] = useState('');
  const [permission, setPermission] = useState<SharePermission>('read');
  const [error, setError] = useState('');
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);

  const handleCreate = () => {
    const err = validateShareProposal({ vault_id: 'current-vault', recipient_id: recipientId.trim(), permission, item_ids: [] });
    if (err) { setError(err); return; }
    setError('');
    onCreate?.({ recipient_id: recipientId.trim(), permission, item_ids: [] });
    setRecipientId('');
  };

  return (
    <div className="p-5">
      <h2 className="text-base font-semibold">Sharing</h2>
      <p className="mt-1 text-sm text-zinc-400">
        Share a vault with another person via a wrapped key envelope — the server sees only the envelope and opaque ids, never plaintext or the Vault Key.
      </p>
      <p className="mt-2 rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
        Sharing is modelled here, not production-ready: the HPKE key-exchange step is not implemented yet. Do not treat a share created from this screen as secure until that protocol is wired and tested.
      </p>

      <section className="card mt-4 p-4" aria-label="Create a share">
        <h3 className="text-sm font-semibold">Share this vault</h3>
        <div className="mt-3 space-y-3">
          <div>
            <label className="label" htmlFor="share-recipient">Recipient user id</label>
            <input id="share-recipient" name="recipient-id" type="text" className="input" value={recipientId} onChange={(e) => setRecipientId(e.target.value)} placeholder="Opaque recipient id (never a name in plaintext on the server)" autoComplete="off" />
          </div>
          <div>
            <label className="label" htmlFor="share-permission">Permission</label>
            <select id="share-permission" name="permission" className="input" value={permission} onChange={(e) => setPermission(e.target.value as SharePermission)}>
              <option value="read">Read — view and copy</option>
              <option value="write">Write — view, copy and edit shared items</option>
            </select>
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button className="btn-primary" onClick={handleCreate}>Create share proposal</button>
        </div>
      </section>

      <section className="mt-4" aria-label="Existing shares">
        {shares.length === 0 ? (
          <p className="text-sm text-zinc-500">No shares yet.</p>
        ) : (
          <ul className="space-y-2">
            {shares.map((share) => (
              <li key={share.id} className="card flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-zinc-100">Recipient: {share.recipient_id}</p>
                  <p className="text-xs text-zinc-400">
                    {share.permission} · {share.status} · {isWholeVaultShare(share) ? 'whole vault' : `${share.item_ids.length} item(s)`} ·
                    {canRead(share) ? ' can read' : ''}{canWrite(share) ? ' · can write' : ''}
                    {share.revoked_at ? ` · revoked ${share.revoked_at}` : ''}
                  </p>
                </div>
                {share.status === 'active' && (
                  confirmRevokeId === share.id ? (
                    <span className="flex gap-2">
                      <button className="btn-ghost !py-1 text-xs" onClick={() => setConfirmRevokeId(null)}>Cancel</button>
                      <button className="btn-primary !py-1 text-xs" onClick={() => { onRevoke?.(share); setConfirmRevokeId(null); }}>Confirm revoke</button>
                    </span>
                  ) : (
                    <button className="btn-ghost !py-1 text-xs" onClick={() => setConfirmRevokeId(share.id)}>Revoke</button>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-zinc-500">
          Revoking removes the key envelope and the share record. It does not erase copies a recipient already decrypted — re-sharing after revocation requires key rotation.
        </p>
      </section>
    </div>
  );
}
