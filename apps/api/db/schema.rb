# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[7.2].define(version: 2026_11_18_020205) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "plpgsql"

  create_table "account_tombstones", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "user_id_digest", null: false
    t.datetime "deleted_at", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["user_id_digest"], name: "index_account_tombstones_on_user_id_digest", unique: true
  end

  create_table "audit_events", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "user_id"
    t.uuid "device_id"
    t.string "event_type", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.jsonb "metadata", default: {}
    t.index ["device_id"], name: "index_audit_events_on_device_id"
    t.index ["user_id"], name: "index_audit_events_on_user_id"
  end

  create_table "authenticators", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "user_id", null: false
    t.string "credential_id", null: false
    t.binary "public_key", null: false
    t.bigint "sign_count", default: 0, null: false
    t.datetime "revoked_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.datetime "reapproval_required_at"
    t.index ["credential_id"], name: "index_authenticators_on_credential_id", unique: true
    t.index ["user_id"], name: "index_authenticators_on_user_id"
  end

  create_table "blob_parts", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "blob_id", null: false
    t.integer "part_number", null: false
    t.string "object_key", null: false
    t.bigint "ciphertext_size", default: 0, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["blob_id", "part_number"], name: "index_blob_parts_on_blob_id_and_part_number", unique: true
    t.index ["blob_id"], name: "index_blob_parts_on_blob_id"
  end

  create_table "blobs", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "vault_id", null: false
    t.string "storage_key", null: false
    t.binary "encrypted_manifest"
    t.bigint "ciphertext_size", default: 0, null: false
    t.string "status", default: "pending", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.datetime "upload_expires_at"
    t.index ["status", "upload_expires_at"], name: "index_blobs_on_status_and_upload_expires_at"
    t.index ["vault_id"], name: "index_blobs_on_vault_id"
  end

  create_table "device_challenges", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "user_id", null: false
    t.uuid "session_id", null: false
    t.string "purpose", null: false
    t.string "challenge_digest", null: false
    t.datetime "expires_at", null: false
    t.datetime "consumed_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["challenge_digest"], name: "index_device_challenges_on_challenge_digest", unique: true
    t.index ["session_id"], name: "index_device_challenges_on_session_id"
    t.index ["user_id"], name: "index_device_challenges_on_user_id"
  end

  create_table "device_checkpoints", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "device_id", null: false
    t.uuid "vault_id", null: false
    t.bigint "last_sequence", default: 0, null: false
    t.binary "checkpoint_hash"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["device_id"], name: "index_device_checkpoints_on_device_id"
    t.index ["vault_id"], name: "index_device_checkpoints_on_vault_id"
  end

  create_table "devices", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "user_id", null: false
    t.binary "public_key", null: false
    t.binary "name_encrypted"
    t.datetime "last_seen_at"
    t.datetime "revoked_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "platform"
    t.datetime "trusted_at"
    t.string "public_key_alg"
    t.uuid "authenticator_id"
    t.index ["authenticator_id"], name: "index_devices_on_authenticator_id"
    t.index ["public_key"], name: "index_devices_on_ed25519_public_key", unique: true, where: "((public_key_alg)::text = 'ed25519'::text)"
    t.index ["user_id"], name: "index_devices_on_user_id"
  end

  create_table "email_verifications", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "email", null: false
    t.string "code_digest", null: false
    t.datetime "expires_at", null: false
    t.integer "attempts", default: 0, null: false
    t.datetime "consumed_at"
    t.datetime "verified_at"
    t.string "ticket_digest"
    t.datetime "ticket_expires_at"
    t.datetime "ticket_consumed_at"
    t.uuid "pending_user_id", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["email"], name: "index_email_verifications_on_email"
    t.index ["ticket_digest"], name: "index_email_verifications_on_ticket_digest", unique: true
  end

  create_table "identity_keys", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "user_id", null: false
    t.binary "public_key", null: false
    t.binary "encrypted_secret_key", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["user_id"], name: "index_identity_keys_on_user_id", unique: true
  end

  create_table "item_shares", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "owner_id", null: false
    t.uuid "recipient_id", null: false
    t.string "permission", null: false
    t.string "status", default: "pending", null: false
    t.datetime "expires_at"
    t.binary "owner_public_key", null: false
    t.binary "recipient_public_key", null: false
    t.integer "revision", default: 1, null: false
    t.binary "encrypted_payload"
    t.binary "encrypted_item_key"
    t.binary "encrypted_owner_metadata"
    t.uuid "last_writer_id"
    t.datetime "accepted_at"
    t.datetime "revoked_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["owner_id"], name: "index_item_shares_on_owner_id"
    t.index ["recipient_id"], name: "index_item_shares_on_recipient_id"
  end

  create_table "item_versions", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "item_id", null: false
    t.integer "revision", null: false
    t.binary "encrypted_payload", null: false
    t.binary "encrypted_item_key", null: false
    t.integer "encryption_version", default: 1, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["item_id", "revision"], name: "index_item_versions_on_item_id_and_revision", unique: true
    t.index ["item_id"], name: "index_item_versions_on_item_id"
  end

  create_table "items", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "vault_id", null: false
    t.integer "current_revision", default: 0, null: false
    t.datetime "deleted_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["vault_id"], name: "index_items_on_vault_id"
  end

  create_table "key_envelopes", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "vault_id", null: false
    t.uuid "recipient_id", null: false
    t.integer "key_version", null: false
    t.binary "encrypted_key", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["vault_id"], name: "index_key_envelopes_on_vault_id"
  end

  create_table "mfa_challenges", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "user_id", null: false
    t.uuid "device_id"
    t.string "token_digest", null: false
    t.datetime "expires_at", null: false
    t.datetime "consumed_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.jsonb "pending_device"
    t.uuid "authenticator_id"
    t.index ["authenticator_id"], name: "index_mfa_challenges_on_authenticator_id"
    t.index ["device_id"], name: "index_mfa_challenges_on_device_id"
    t.index ["token_digest"], name: "index_mfa_challenges_on_token_digest", unique: true
    t.index ["user_id"], name: "index_mfa_challenges_on_user_id"
  end

  create_table "passkey_challenges", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "email", null: false
    t.string "challenge", null: false
    t.string "kind", default: "authentication", null: false
    t.datetime "expires_at", null: false
    t.datetime "consumed_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.uuid "email_verification_id"
    t.index ["email", "challenge"], name: "index_passkey_challenges_on_email_and_challenge", unique: true
    t.index ["email_verification_id"], name: "index_passkey_challenges_on_email_verification_id"
  end

  create_table "recovery_challenges", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "user_id", null: false
    t.string "challenge_digest", null: false
    t.text "challenge_encrypted", null: false
    t.string "kind", default: "recovery_key", null: false
    t.datetime "expires_at", null: false
    t.datetime "consumed_at"
    t.integer "attempts", default: 0, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["user_id"], name: "index_recovery_challenges_on_user_id"
  end

  create_table "recovery_codes", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "user_id", null: false
    t.string "code_digest", null: false
    t.datetime "used_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["user_id", "code_digest"], name: "index_recovery_codes_on_user_id_and_code_digest", unique: true
    t.index ["user_id"], name: "index_recovery_codes_on_user_id"
  end

  create_table "recovery_verifiers", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "user_id", null: false
    t.string "public_key", null: false
    t.datetime "revoked_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "derivation", default: "v0-raw-recovery-key", null: false
    t.index ["user_id"], name: "index_recovery_verifiers_on_user_id"
  end

  create_table "sessions", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "user_id", null: false
    t.uuid "device_id"
    t.string "token_digest", null: false
    t.datetime "expires_at", null: false
    t.datetime "revoked_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.datetime "step_up_verified_at"
    t.string "step_up_method"
    t.boolean "recovery_session", default: false, null: false
    t.string "user_agent"
    t.string "ip_address"
    t.uuid "authenticator_id"
    t.index ["authenticator_id"], name: "index_sessions_on_authenticator_id"
    t.index ["device_id"], name: "index_sessions_on_device_id"
    t.index ["token_digest"], name: "index_sessions_on_token_digest", unique: true
    t.index ["user_id"], name: "index_sessions_on_user_id"
  end

  create_table "shares", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "vault_id", null: false
    t.uuid "owner_id", null: false
    t.uuid "recipient_id"
    t.string "permission", default: "read", null: false
    t.string "status", default: "pending", null: false
    t.binary "encrypted_key"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["owner_id"], name: "index_shares_on_owner_id"
    t.index ["recipient_id"], name: "index_shares_on_recipient_id"
    t.index ["vault_id", "recipient_id"], name: "index_shares_on_vault_id_and_recipient_id", unique: true
    t.index ["vault_id"], name: "index_shares_on_vault_id"
  end

  create_table "sync_events", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "vault_id", null: false
    t.bigint "sequence", null: false
    t.uuid "item_id", null: false
    t.integer "revision", null: false
    t.string "operation", null: false
    t.uuid "device_id"
    t.binary "signature"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["device_id"], name: "index_sync_events_on_device_id"
    t.index ["item_id", "revision"], name: "index_sync_events_on_item_id_and_revision", unique: true
    t.index ["vault_id", "sequence"], name: "index_sync_events_on_vault_id_and_sequence", unique: true
    t.index ["vault_id"], name: "index_sync_events_on_vault_id"
  end

  create_table "users", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "email", null: false
    t.string "status", default: "active", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.boolean "mfa_enabled", default: false, null: false
    t.text "totp_secret_ciphertext"
    t.integer "totp_last_step"
    t.datetime "totp_confirmed_at"
    t.index ["email"], name: "index_users_on_email", unique: true
  end

  create_table "vaults", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "owner_id", null: false
    t.integer "key_version", default: 1, null: false
    t.binary "encrypted_metadata"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["owner_id"], name: "index_vaults_on_owner_id"
  end

  add_foreign_key "audit_events", "devices"
  add_foreign_key "audit_events", "users"
  add_foreign_key "authenticators", "users"
  add_foreign_key "blob_parts", "blobs"
  add_foreign_key "blobs", "vaults"
  add_foreign_key "device_challenges", "sessions", on_delete: :cascade
  add_foreign_key "device_challenges", "users", on_delete: :cascade
  add_foreign_key "device_checkpoints", "devices"
  add_foreign_key "device_checkpoints", "vaults"
  add_foreign_key "devices", "authenticators", on_delete: :nullify
  add_foreign_key "devices", "users"
  add_foreign_key "identity_keys", "users"
  add_foreign_key "item_shares", "users", column: "owner_id"
  add_foreign_key "item_shares", "users", column: "recipient_id"
  add_foreign_key "item_versions", "items"
  add_foreign_key "items", "vaults"
  add_foreign_key "key_envelopes", "vaults"
  add_foreign_key "mfa_challenges", "authenticators", on_delete: :nullify
  add_foreign_key "mfa_challenges", "devices"
  add_foreign_key "mfa_challenges", "users"
  add_foreign_key "passkey_challenges", "email_verifications", on_delete: :cascade
  add_foreign_key "recovery_challenges", "users"
  add_foreign_key "recovery_codes", "users"
  add_foreign_key "recovery_verifiers", "users"
  add_foreign_key "sessions", "authenticators", on_delete: :nullify
  add_foreign_key "sessions", "devices"
  add_foreign_key "sessions", "users"
  add_foreign_key "shares", "users", column: "owner_id"
  add_foreign_key "shares", "users", column: "recipient_id"
  add_foreign_key "shares", "vaults"
  add_foreign_key "sync_events", "devices"
  add_foreign_key "sync_events", "vaults"
  add_foreign_key "vaults", "users", column: "owner_id"
end
