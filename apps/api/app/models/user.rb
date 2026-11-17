class User < ApplicationRecord
  has_many :authenticators, dependent: :destroy
  has_many :devices, dependent: :destroy
  has_many :vaults, foreign_key: :owner_id, dependent: :destroy
  has_many :blobs, through: :vaults
  has_many :shares, foreign_key: :recipient_id, dependent: :destroy
  has_many :owned_shares, class_name: 'Share', foreign_key: :owner_id, dependent: :destroy
  has_many :audit_events, dependent: :nullify
  has_many :sessions, dependent: :destroy
  has_many :recovery_challenges, dependent: :destroy
  has_many :recovery_verifiers, dependent: :destroy
  has_many :recovery_codes, dependent: :destroy
  has_many :mfa_challenges, dependent: :destroy

  validates :email, presence: true, uniqueness: { case_sensitive: false },
                    format: { with: URI::MailTo::EMAIL_REGEXP }
  validates :status, inclusion: { in: %w[active suspended deleted] }

  before_validation { self.email = email&.strip&.downcase }
end
