module Sharing
  # Current revision of a share's encrypted record for one of its parties.
  # Pending shares give the recipient the wrapped Share Key only (enough to
  # verify the key exchange), never the payload.
  module ReadRecord
    module_function

    def call(share:, user:)
      Access.check!(share: share, user: user, action: :read)
      Presenter.record(share, include_payload: Access.payload_visible?(share: share, user: user))
    end
  end
end
