module KeyEnvelopes
  # Rotation after a device is revoked or a key is suspected compromised.
  # The SERVER cannot re-wrap keys (it cannot decrypt them). It can only
  # delete the revoked recipient's envelopes; the CLIENT must then create
  # fresh envelopes for the remaining recipients with the new vault key
  # version and upload them. Until the client does, sync for that vault
  # is paused for the revoked recipient only.
  module Rotate
    module_function
    def call(vault_ids:, revoked_recipient_id:)
      KeyEnvelope.where(vault_id: vault_ids, recipient_id: revoked_recipient_id).delete_all
    end
  end
end
