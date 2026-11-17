module Sharing
  # Server-side permission rules for a share's encrypted record
  # (specs/sharing-protocol.md §6 table). The caller has already been
  # scoped to owner-or-recipient (anyone else gets 404 before this).
  module Access
    module_function

    # action: :read or :write. Raises Failure (403) when refused.
    # A recipient may :read a PENDING share; ReadRecord then returns the
    # wrapped key only, so the client can verify the key exchange before
    # accepting — never the payload.
    def check!(share:, user:, action:)
      raise Failure.forbidden('share_revoked') if share.revoked?
      raise Failure.forbidden('share_expired') if share.expired?
      return if share.owner?(user)
      return if action == :read

      raise Failure.forbidden('share_not_active') unless share.active?
      raise Failure.forbidden('write_not_permitted') unless share.writable?
    end

    def payload_visible?(share:, user:) = share.owner?(user) || share.active?
  end
end
