module Blobs
  # Ciphertext bytes counted against Billing::Quota::STORAGE_LIMIT_BYTES.
  # A complete blob counts with its stored size; an upload session that has
  # not expired reserves its declared size. An expired session stops
  # counting at once, before OrphanBlobCleanupJob deletes its objects.
  module Usage
    module_function

    def complete_bytes(user:, except: nil)
      user.blobs.where(status: 'complete').where.not(id: except&.id).sum(:ciphertext_size)
    end

    def in_flight_bytes(user:, now: Time.current)
      user.blobs.where(status: 'uploading', upload_expires_at: now..).sum(:ciphertext_size)
    end
  end
end
