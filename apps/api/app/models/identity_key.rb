# A user's X25519 sharing identity (specs/sharing-protocol.md §3).
# public_key: 32 raw bytes. encrypted_secret_key: opaque ciphertext under the
# user's Vault Key — the server cannot decrypt it. Write-once in v1.
class IdentityKey < ApplicationRecord
  belongs_to :user
  validates :public_key, :encrypted_secret_key, presence: true
  validates :user_id, uniqueness: true
end
