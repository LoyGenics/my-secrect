# Vault data — items, the sync log, key envelopes — is served only to a
# session bound to an active (non-revoked) device of the signed-in user.
#
# Revoking a device revokes its sessions, which authenticate_request!
# already turns into 401. This check also refuses (403) a session that is
# still live while its device is revoked (e.g. issued in the same instant as
# the revocation), a session bound to another user's device, and a session
# with no device at all (a recovery session after every device was
# revoked: sign in with a passkey to get an active device first).
#
# Another user's vault is not looked up here: controllers scope vaults to
# current_user, so it is 404, exactly like a vault that does not exist.
module ActiveDeviceRequired
  extend ActiveSupport::Concern

  included do
    before_action :require_active_device!
  end

  private

  def require_active_device!
    return if current_device&.user_id == current_user.id && !current_device.revoked?
    render json: { error: 'device_not_authorized' }, status: :forbidden
  end
end
