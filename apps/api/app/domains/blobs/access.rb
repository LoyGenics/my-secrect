module Blobs
  # Who may use a blob. Today: only the owner of the blob's vault.
  #
  # Sharing hook: when vault sharing grants read access, `readable` (used by
  # download-session) is the ONE place to extend — e.g. also accept a blob
  # whose vault has an accepted share with this user as recipient. Nothing
  # does that yet: a share row grants no blob access. Upload and complete
  # stay owner-only (`writable`).
  module Access
    module_function

    def writable(user:, id:) = user.blobs.find(id)
    def readable(user:, id:) = user.blobs.find(id)
  end
end
