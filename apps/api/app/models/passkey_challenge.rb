class PasskeyChallenge < ApplicationRecord
  validates :email, :challenge, :expires_at, presence: true
  scope :live, -> { where(consumed_at: nil).where('expires_at > ?', Time.current) }

  # Atomic single-winner consume: one conditional UPDATE. Returns true only
  # for the single caller whose UPDATE touched the row; every concurrent or
  # later caller (or an expired challenge) gets false and must fail closed.
  def consume!
    now = Time.current
    updated = self.class.where(id: id, consumed_at: nil).where('expires_at > ?', now)
                  .update_all(consumed_at: now, updated_at: now)
    updated == 1
  end
end
