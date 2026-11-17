# WorkOS-inspired security features (strict scope, 17 Nov 2026):
# step-up auth, TOTP MFA + recovery codes, real recovery challenges
# (H5 fix), passkey management, session/device management, audit metadata.
# Account auth only — none of this touches vault unlock or decryption keys.
class AddWorkosSecurityFeatures < ActiveRecord::Migration[7.1]
  def change
    change_table :sessions, bulk: true do |t|
      t.datetime :step_up_verified_at
      t.string :step_up_method
      t.boolean :recovery_session, default: false, null: false
      t.string :user_agent
      t.string :ip_address
    end

    change_table :devices, bulk: true do |t|
      t.string :platform
      t.datetime :trusted_at
    end

    change_table :users, bulk: true do |t|
      t.boolean :mfa_enabled, default: false, null: false
      t.text :totp_secret_ciphertext
      t.integer :totp_last_step
      t.datetime :totp_confirmed_at
    end

    create_table :recovery_challenges, id: :uuid do |t|
      t.references :user, null: false, foreign_key: true, type: :uuid
      t.string :challenge_digest, null: false
      # MessageEncryptor ciphertext of the base64url challenge, so verify
      # can recover the exact challenge bytes without storing them raw.
      t.text :challenge_encrypted, null: false
      t.string :kind, null: false, default: 'recovery_key'
      t.datetime :expires_at, null: false
      t.datetime :consumed_at
      t.integer :attempts, null: false, default: 0
      t.timestamps
    end

    create_table :recovery_verifiers, id: :uuid do |t|
      t.references :user, null: false, foreign_key: true, type: :uuid
      # Base64 Ed25519 verify key (public by nature; only a fingerprint is
      # ever returned by the API). 32 bytes after base64 decode.
      t.string :public_key, null: false
      t.datetime :revoked_at
      t.timestamps
    end

    create_table :recovery_codes, id: :uuid do |t|
      t.references :user, null: false, foreign_key: true, type: :uuid
      # SHA-256 hex digest ONLY — the code itself is never stored.
      t.string :code_digest, null: false
      t.datetime :used_at
      t.timestamps
      t.index %i[user_id code_digest], unique: true
    end

    create_table :mfa_challenges, id: :uuid do |t|
      t.references :user, null: false, foreign_key: true, type: :uuid
      # Device the pending login will bind to (chosen at passkey-verify
      # time, so the second-factor step needs no public key of its own).
      t.references :device, foreign_key: true, type: :uuid
      t.string :token_digest, null: false
      t.datetime :expires_at, null: false
      t.datetime :consumed_at
      t.timestamps
      t.index [:token_digest], unique: true
    end

    add_column :audit_events, :metadata, :jsonb, default: {}
  end
end
