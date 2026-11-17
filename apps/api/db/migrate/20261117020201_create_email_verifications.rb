# Email ownership before account creation. A user row used to be created
# at registration-options time for any email anyone typed; now an account
# is only created after (1) a 6-digit code sent to the address is entered
# and (2) a passkey attestation verifies (Authentication::EmailOwnership).
# Codes and tickets are stored as digests only.
class CreateEmailVerifications < ActiveRecord::Migration[7.1]
  def change
    create_table :email_verifications, id: :uuid do |t|
      t.string :email, null: false
      # HMAC-SHA-256 (server key, per-row message) of the code — never the code.
      t.string :code_digest, null: false
      t.datetime :expires_at, null: false
      t.integer :attempts, null: false, default: 0
      # Set when the code is used, superseded by a newer code, or burned
      # after the last allowed attempt.
      t.datetime :consumed_at
      t.datetime :verified_at
      # SHA-256 of the registration ticket minted by a successful verify.
      t.string :ticket_digest
      t.datetime :ticket_expires_at
      t.datetime :ticket_consumed_at
      # Id the account will get if this ticket creates it (also the
      # WebAuthn user handle). Not a foreign key: the user does not exist yet.
      t.uuid :pending_user_id, null: false
      t.timestamps
      t.index :email
      t.index :ticket_digest, unique: true
    end

    # Registration challenges minted with a ticket point at it, so the
    # unauthenticated registration verify can only succeed for a challenge
    # that was obtained with a verified email.
    add_reference :passkey_challenges, :email_verification, type: :uuid, index: true,
                                                            foreign_key: { on_delete: :cascade }
  end
end
