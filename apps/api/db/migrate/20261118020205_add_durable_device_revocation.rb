# Durable device revocation (specs/device-identity.md §6.3, QA DEFECT-H2).
# A revoked browser used to sign straight back in with the same passkey and
# enrol a fresh device key. Now every device records the passkey that
# enrolled it, and revoking the device either revokes that passkey or
# marks it as needing re-approval from a still-trusted device before it can
# enrol another device.
class AddDurableDeviceRevocation < ActiveRecord::Migration[7.2]
  def change
    # The passkey (authenticator) whose sign-in enrolled the device.
    add_reference :devices, :authenticator, type: :uuid, index: true, foreign_key: { on_delete: :nullify }
    # The passkey that authenticated the session (nil for recovery sessions),
    # so a device enrolled later from that session can be attributed.
    add_reference :sessions, :authenticator, type: :uuid, index: true, foreign_key: { on_delete: :nullify }
    add_reference :mfa_challenges, :authenticator, type: :uuid, index: true, foreign_key: { on_delete: :nullify }
    # Set when a device this passkey enrolled was revoked: until re-approved,
    # it may only sign in by binding an ACTIVE device, never enrol a new one.
    add_column :authenticators, :reapproval_required_at, :datetime
  end
end
