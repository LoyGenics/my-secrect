# Single-use challenge for the explicit device enrol/bind flow
# (Authentication::DeviceProof). Stores SHA-256 of the challenge only.
class DeviceChallenge < ApplicationRecord
  belongs_to :user
  belongs_to :session
  validates :purpose, :challenge_digest, :expires_at, presence: true
end
