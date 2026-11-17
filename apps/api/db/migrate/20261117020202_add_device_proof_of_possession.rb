# Device proof-of-possession (specs/device-identity.md). Sessions used to be
# attached to the account's first device without any proof; now a session
# is bound to a device only after the client signs a fresh, single-use
# server challenge with that device's Ed25519 key.
class AddDeviceProofOfPossession < ActiveRecord::Migration[7.1]
  def change
    # 'ed25519' for keys enrolled with proof of possession (raw 32-byte
    # public key in devices.public_key). NULL for legacy rows, which hold
    # the passkey's COSE key and can never satisfy a device proof.
    add_column :devices, :public_key_alg, :string
    # One device row per device key.
    add_index :devices, :public_key, unique: true, where: "public_key_alg = 'ed25519'",
                                     name: 'index_devices_on_ed25519_public_key'

    # Challenges for the explicit (authenticated) enrol/bind flow. Only
    # SHA-256 of the challenge is stored; bound to user, session, purpose.
    create_table :device_challenges, id: :uuid do |t|
      t.references :user, null: false, type: :uuid, foreign_key: { on_delete: :cascade }
      t.references :session, null: false, type: :uuid, foreign_key: { on_delete: :cascade }
      t.string :purpose, null: false
      t.string :challenge_digest, null: false
      t.datetime :expires_at, null: false
      t.datetime :consumed_at
      t.timestamps
      t.index :challenge_digest, unique: true
    end

    # A device enrolment proven at the passkey step of an MFA login, held
    # until the second factor succeeds: { public_key (base64url), platform,
    # name_encrypted }. Public data only.
    add_column :mfa_challenges, :pending_device, :jsonb
  end
end
