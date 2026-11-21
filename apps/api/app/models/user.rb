class User < ApplicationRecord
  has_many :billing_accounts, dependent: :destroy
  has_many :billing_purchases, dependent: :delete_all
  has_one :owned_family, class_name: 'Family', foreign_key: :owner_id, dependent: :destroy
  has_one :family_membership, dependent: :destroy
  has_many :authenticators, dependent: :destroy
  has_many :user_identities, dependent: :delete_all
  # Session.device_id is a foreign key: remove sessions before devices.
  has_many :sessions, dependent: :destroy
  has_many :devices, dependent: :destroy
  has_many :vaults, foreign_key: :owner_id, dependent: :destroy
  has_many :blobs, through: :vaults
  has_many :shares, foreign_key: :recipient_id, dependent: :destroy
  has_many :owned_shares, class_name: 'Share', foreign_key: :owner_id, dependent: :destroy
  # Sharing v1 (specs/sharing-protocol.md). Deleted with the user so account
  # deletion leaves no identity key or share ciphertext behind.
  has_many :share_links, foreign_key: :owner_id, dependent: :delete_all
  has_one :identity_key, dependent: :delete
  has_many :owned_item_shares, class_name: 'ItemShare', foreign_key: :owner_id, dependent: :delete_all
  has_many :received_item_shares, class_name: 'ItemShare', foreign_key: :recipient_id, dependent: :delete_all
  has_many :audit_events, dependent: :nullify
  has_many :recovery_challenges, dependent: :destroy
  has_many :recovery_verifiers, dependent: :destroy
  has_many :recovery_codes, dependent: :destroy
  has_many :mfa_challenges, dependent: :destroy

  validates :email, presence: true, uniqueness: { case_sensitive: false },
                    format: { with: URI::MailTo::EMAIL_REGEXP }
  validates :status, inclusion: { in: %w[active suspended deleted] }

  before_validation { self.email = email&.strip&.downcase }

  # True once the account has ever had a passkey or MFA. Only an unclaimed
  # row (a pre-email-verification leftover that never finished
  # registration) may be completed by the verified-email sign-up flow.
  def claimed? = authenticators.exists? || mfa_enabled?

  # True while the account has a usable passkey. Such an account signs in
  # with the passkey only: the email-code sign-in is closed for it.
  def passkey_account? = authenticators.active.exists?
end
