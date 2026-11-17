# How the client derived the recovery verifier key (specs/recovery-protocol.md,
# "Recovery verifier key"). Rows that exist before this migration were
# registered with the recovery key itself as the Ed25519 seed (v0); new
# registrations must use the domain-separated HKDF derivation (v1).
class AddDerivationToRecoveryVerifiers < ActiveRecord::Migration[7.1]
  def change
    add_column :recovery_verifiers, :derivation, :string, null: false, default: 'v0-raw-recovery-key'
  end
end
