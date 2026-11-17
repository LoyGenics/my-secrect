class AuditEvent < ApplicationRecord
  belongs_to :user, optional: true
  belongs_to :device, optional: true
  validates :event_type, presence: true
  # Audit events record WHAT happened (login, device enrolled/revoked,
  # share created/revoked, recovery challenged) — never vault content.
end
