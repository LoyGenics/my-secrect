module Devices
  module Revoke
    module_function
    # Revoking a device: mark revoked, revoke its sessions, restrict the
    # passkey that enrolled it, and schedule key-envelope rotation so its
    # wrapped vault key stops working.
    #
    # Durable (specs/device-identity.md §6.3, QA DEFECT-H2): without the
    # passkey step, the revoked browser could sign straight back in with
    # the same passkey and enrol a fresh device key. So:
    #   * revoke_passkey: true  -> the enrolling passkey is revoked too
    #     (the caller enforces step-up and the last-passkey guard);
    #   * otherwise             -> that passkey is marked
    #     reapproval_required: it can still sign in on devices that are
    #     active (binding them), but cannot enrol a new device until it is
    #     re-approved from a still-trusted device;
    #   * enrolling passkey unknown (devices enrolled before this rule, or
    #     from a recovery session) -> EVERY active passkey of the account is
    #     marked reapproval_required (secure default).
    #
    # Revocation invalidates server sessions and rotates key envelopes
    # only — it does NOT erase secrets already downloaded/offline on that
    # device, and the vault key it already holds still decrypts anything
    # encrypted under it; only rotating the vault key (not implemented yet)
    # would protect items created afterwards.
    #
    # Returns what happened to the passkey: 'revoked', 'reapproval_required'
    # or 'reapproval_required_all'.
    def call(device:, revoke_passkey: false)
      now = Time.current
      passkey = nil
      ActiveRecord::Base.transaction do
        device.update!(revoked_at: now)
        Session.where(device: device).update_all(revoked_at: now)
        passkey = restrict_passkeys!(device: device, revoke: revoke_passkey, at: now)
      end
      KeyEnvelopes::Rotate.call(vault_ids: device.user.vaults.pluck(:id), revoked_recipient_id: device.id)
      Audit::Log.call(user: device.user, device: device, event_type: 'device_revoked', metadata: { passkey: passkey })
      passkey
    end

    def restrict_passkeys!(device:, revoke:, at:)
      authenticator = device.authenticator
      unless authenticator
        device.user.authenticators.active.update_all(reapproval_required_at: at, updated_at: at)
        return 'reapproval_required_all'
      end
      if revoke
        authenticator.update!(revoked_at: at) unless authenticator.revoked?
        Audit::Log.call(user: device.user, event_type: 'passkey_removed', metadata: { via: 'device_revoke' })
        return 'revoked'
      end
      authenticator.update!(reapproval_required_at: at) unless authenticator.reapproval_required?
      'reapproval_required'
    end
  end
end
