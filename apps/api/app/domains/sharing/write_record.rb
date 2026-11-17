module Sharing
  # Replace the share's encrypted record with a new revision (fresh Share Key
  # chosen by the writer's client). Owner: pending or active. Recipient:
  # active + write permission only. Revision-checked like sync: a stale
  # base_revision is 409 and writes nothing. Access is re-checked under the
  # row lock so a write cannot race a revocation.
  module WriteRecord
    module_function

    def call(share:, user:, base_revision:, encrypted_payload:, encrypted_item_key:)
      Access.check!(share: share, user: user, action: :write)
      base = Integer(base_revision, exception: false)
      raise Failure.invalid('base_revision must be an integer') unless base

      payload = Wire.payload!(encrypted_payload)
      wrapped_key = Wire.wrapped_share_key!(encrypted_item_key)
      share.with_lock do
        Access.check!(share: share, user: user, action: :write)
        raise Failure.conflict('revision_conflict', details: { current_revision: share.revision }) unless base == share.revision

        share.update!(revision: share.revision + 1, encrypted_payload: payload, encrypted_item_key: wrapped_key, last_writer_id: user.id)
      end
      Audit::Log.call(
        user: user, event_type: 'share_record_written',
        metadata: { share_id: share.id, revision: share.revision, by: share.owner?(user) ? 'owner' : 'recipient' }
      )
      Presenter.record(share, include_payload: false)
    end
  end
end
