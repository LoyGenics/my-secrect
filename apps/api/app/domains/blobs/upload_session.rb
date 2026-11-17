module Blobs
  module UploadSession
    MAX_BLOB_BYTES = 5 * 1024 * 1024 * 1024 # 5 GiB per blob (v1 cap; quota domain enforces per-user)
    PART_BYTES = 8 * 1024 * 1024 # max ciphertext bytes per part (one presigned PUT)
    # Phase C fix (H8): part_count was uncapped — a client could request
    # millions of presigned URLs / part rows. 5 GiB at 8 MiB/part needs at
    # most 640 parts; the cap allows 1 MiB client chunks (one part each)
    # up to the 5 GiB limit with headroom. Anything above is rejected.
    MAX_PART_COUNT = 5_120
    # An upload session (and the quota it reserves) lives this long after it
    # was opened or last resumed. Expired sessions cannot be resumed or
    # completed; OrphanBlobCleanupJob deletes their objects and rows.
    UPLOAD_SESSION_TTL = 24.hours
    UUID = /\A\h{8}-\h{4}-\h{4}-\h{4}-\h{12}\z/
    module_function
    # Phase C fix (H8): the upload session REQUIRES the client's
    # Vault-Key-encrypted manifest (`encrypted_manifest`, base64). The
    # manifest is where the wrapped File Key lives (see
    # packages/storage/src/upload.ts: BlobManifest.wrapped_file_key) —
    # without it a download can never be decrypted. The server stores the
    # manifest opaquely on the blob row and returns it verbatim at download
    # time; it never decrypts it and never sees a plaintext File Key.
    #
    # Part layout: every part but the last is exactly `part_size` bytes of
    # ciphertext, the last is 1..part_size. Each part's exact size is
    # stored on its row and signed into its presigned PUT (Content-Length),
    # so storage refuses any other length.
    #
    # Quota is enforced HERE, before any part rows or presigned URLs exist:
    # complete blobs + unexpired in-flight sessions + this blob must fit.
    # The owner row is locked so two concurrent sessions cannot both pass.
    #
    # Resume: calling again with the same blob_id, manifest and layout while
    # the session is unexpired re-signs every part URL, extends the session,
    # and marks each part `stored: true` when storage already holds an
    # object of exactly the expected size (one ListObjectsV2 per 1,000
    # parts). The client then sends only the parts that are not stored.
    def call(vault:, blob_id:, part_count:, part_size:, ciphertext_size:, encrypted_manifest: nil, now: Time.current)
      raise ArgumentError, 'blob_id required' if blob_id.blank?
      raise ArgumentError, 'blob_id must be a UUID' unless blob_id.to_s.match?(UUID)
      sizes = part_sizes(part_count.to_i, part_size.to_i, ciphertext_size.to_i)
      manifest_bytes = decode_manifest(encrypted_manifest)
      user = vault.owner
      blob, resumed = vault.transaction do
        user.lock!
        existing = Blob.find_by(id: blob_id)
        next [resume!(existing, vault: vault, sizes: sizes, manifest_bytes: manifest_bytes, now: now), true] if existing

        [create!(vault: vault, user: user, blob_id: blob_id, sizes: sizes, manifest_bytes: manifest_bytes, now: now), false]
      end
      response(blob, resumed: resumed)
    end

    def part_sizes(part_count, part_size, ciphertext_size)
      raise ArgumentError, 'ciphertext_size must be > 0' if ciphertext_size < 1
      raise ArgumentError, "ciphertext_size exceeds the per-blob maximum of #{MAX_BLOB_BYTES} bytes" if ciphertext_size > MAX_BLOB_BYTES
      raise ArgumentError, 'part_count must be >= 1' if part_count < 1
      raise ArgumentError, "part_count exceeds maximum #{MAX_PART_COUNT}" if part_count > MAX_PART_COUNT
      raise ArgumentError, "part_size must be between 1 and #{PART_BYTES} bytes" unless part_size.between?(1, PART_BYTES)

      last = ciphertext_size - ((part_count - 1) * part_size)
      unless last.between?(1, part_size)
        raise ArgumentError, 'part_count and part_size do not match ciphertext_size (every part but the last is part_size bytes; the last is 1..part_size)'
      end
      Array.new(part_count - 1, part_size) << last
    end

    def decode_manifest(encrypted_manifest)
      raise ArgumentError, 'encrypted_manifest required (Vault-Key-encrypted manifest carrying the wrapped File Key)' if encrypted_manifest.blank?

      bytes = begin
        Base64.strict_decode64(encrypted_manifest.to_s)
      rescue ArgumentError
        raise ArgumentError, 'encrypted_manifest must be valid base64'
      end
      raise ArgumentError, 'encrypted_manifest is empty' if bytes.empty?
      bytes
    end

    def expires_at(blob) = blob.upload_expires_at || (blob.created_at + UPLOAD_SESSION_TTL)
    def expired?(blob, now) = expires_at(blob) <= now

    def create!(vault:, user:, blob_id:, sizes:, manifest_bytes:, now:)
      ciphertext_size = sizes.sum
      used = Usage.complete_bytes(user: user) + Usage.in_flight_bytes(user: user, now: now)
      raise ArgumentError, 'storage quota exceeded' if used + ciphertext_size > Billing::Quota::STORAGE_LIMIT_BYTES

      blob = vault.blobs.create!(id: blob_id, storage_key: "vaults/#{vault.id}/blobs/#{blob_id}", ciphertext_size: ciphertext_size,
                                 encrypted_manifest: manifest_bytes, status: 'uploading', upload_expires_at: now + UPLOAD_SESSION_TTL)
      rows = sizes.each_with_index.map do |size, i|
        { blob_id: blob.id, part_number: i + 1, object_key: "#{blob.storage_key}/part-#{format('%05d', i + 1)}", ciphertext_size: size }
      end
      BlobPart.insert_all!(rows)
      blob
    end

    def resume!(blob, vault:, sizes:, manifest_bytes:, now:)
      raise ArgumentError, 'blob_id is already in use' unless blob.vault_id == vault.id
      raise ArgumentError, "blob is #{blob.status}; start a new upload with a new blob_id" unless blob.status == 'uploading'
      raise ArgumentError, 'upload session expired; start a new upload with a new blob_id' if expired?(blob, now)

      same_layout = blob.blob_parts.order(:part_number).pluck(:ciphertext_size) == sizes
      unless same_layout && blob.encrypted_manifest.b == manifest_bytes.b
        raise ArgumentError, 'an upload session for this blob_id exists with a different manifest or part layout'
      end
      blob.update!(upload_expires_at: now + UPLOAD_SESSION_TTL)
      blob
    end

    def response(blob, resumed:)
      provider = Blobs.storage_provider
      parts = blob.blob_parts.order(:part_number).to_a
      stored = resumed ? provider.list(prefix: "#{blob.storage_key}/").to_h { |o| [o.key, o.size] } : {}
      url_expires_at = Time.current + StorageProvider::PRESIGN_TTL
      {
        blob_id: blob.id,
        storage_key: blob.storage_key,
        resumed: resumed,
        upload_expires_at: blob.upload_expires_at,
        parts: parts.map do |p|
          { part_number: p.part_number, ciphertext_size: p.ciphertext_size, stored: stored[p.object_key] == p.ciphertext_size,
            url: provider.presigned_put(object_key: p.object_key, content_length: p.ciphertext_size),
            object_key: p.object_key, expires_at: url_expires_at }
        end
      }
    end
  end
end
