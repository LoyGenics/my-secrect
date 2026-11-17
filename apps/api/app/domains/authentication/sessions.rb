module Authentication
  # Session management for the signed-in user. Listing/revoking here
  # invalidates server sessions (and, for devices, rotates key envelopes
  # via Devices::Revoke) — it does NOT erase secrets already downloaded
  # or cached offline on a device (see SessionTokens header comment).
  module Sessions
    module_function

    # Live sessions, newest first. The caller marks the current one.
    def list(user:)
      user.sessions.live.order(created_at: :desc)
    end

    def revoke(session:, user:)
      raise ArgumentError, 'session does not belong to user' unless session.user_id == user.id
      session.update!(revoked_at: Time.current)
      Audit::Log.call(user: user, device: session.device, event_type: 'session_revoked')
      session
    end

    # Revoke every live session except the caller's own. Requires
    # step-up (enforced by the controller). Returns the revoked count.
    def revoke_others(user:, except_session:)
      count = user.sessions.live.where.not(id: except_session.id).update_all(revoked_at: Time.current)
      Audit::Log.call(user: user, device: except_session.device,
                      event_type: 'sessions_revoked_others', metadata: { revoked_count: count })
      count
    end
  end
end
