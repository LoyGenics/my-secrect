/** Portable export v1 — documented format so a user can leave the app.
 *  Export is ENCRYPTED by default (same envelope as sync). A plaintext export
 *  is only ever written when the user explicitly chooses it, locally.
 */
export const EXPORT_FORMAT_VERSION = 1;
export interface VaultExport {
  format: 'my-secrect-vault-export';
  format_version: number;
  exported_at: string;
  vault_id: string;
  items: Array<{ item_id: string; revision: number; encrypted_payload: string; encrypted_item_key: string; encryption_version: number }>;
  relations_included: boolean;
}
export function buildExportSkeleton(vaultId: string): VaultExport {
  return { format: 'my-secrect-vault-export', format_version: EXPORT_FORMAT_VERSION, exported_at: new Date().toISOString(), vault_id: vaultId, items: [], relations_included: true };
}
