module Blobs
  module Complete
    module_function
    # Complete verifies, before marking anything complete:
    #   1. the blob is still 'uploading' and its session has not expired
    #      (no double-complete, no completing a failed/abandoned blob);
    #   2. a Vault-Key-encrypted manifest is stored on the blob row
    #      (it carries the wrapped File Key — see UploadSession);
    #   3. the client-reported `parts` list covers every stored part
    #      exactly once (contiguous 1..N), each with exactly the size the
    #      session declared for it and a well-formed SHA-256 (base64,
    #      32 bytes) of its ciphertext;
    #   4. every part object EXISTS in storage with exactly that size
    #      (ListObjectsV2 over the blob's prefix: one request per 1,000
    #      parts instead of one HEAD per part);
    #   5. the owner's quota still fits: complete blobs + this blob. Racing
    #      sessions each reserved quota at upload-session; the first to
    #      complete wins, a later one that no longer fits is refused.
    # The server cannot verify the manifest's *contents* (it is encrypted
    # with the Vault Key) or re-derive chunk hashes from it — the client
    # does that at download time (packages/storage checks every chunk hash
    # + AEAD tag against the manifest). Part hashes are format-checked here
    # but not persisted.
    # A storage outage therefore fails Complete loudly instead of
    # marking a blob complete that is not really there. That is intended.
    def call(blob:, parts: nil, now: Time.current)
      raise ArgumentError, 'parts list required (part_number, ciphertext_size, ciphertext_sha256_b64 per part)' if parts.blank?

      reported = normalize(parts)
      ensure_completable!(blob, now)
      stored = blob.blob_parts.order(:part_number).to_a
      raise ArgumentError, 'blob has no parts' if stored.empty?
      raise ArgumentError, "parts count mismatch: expected #{stored.size}, got #{reported.size}" unless reported.size == stored.size
      unless reported.map { |p| p[:part_number] }.sort == (1..stored.size).to_a
        raise ArgumentError, 'part numbers must be contiguous 1..N with no gaps or duplicates'
      end

      by_number = reported.index_by { |p| p[:part_number] }
      stored.each do |part|
        expected = part.ciphertext_size
        got = by_number[part.part_number][:ciphertext_size]
        raise ArgumentError, "part #{part.part_number} ciphertext_size #{got} differs from the session's #{expected}" unless got == expected
      end
      verify_storage!(blob, stored)

      blob.transaction do
        blob.vault.owner.lock!
        blob.lock!
        ensure_completable!(blob, now)
        used = Usage.complete_bytes(user: blob.vault.owner, except: blob)
        raise ArgumentError, 'storage quota exceeded' if used + blob.ciphertext_size > Billing::Quota::STORAGE_LIMIT_BYTES

        blob.update!(status: 'complete', upload_expires_at: nil)
      end
      blob
    end

    def normalize(parts)
      parts.map do |p|
        n = p[:part_number] || p['part_number']
        size = p[:ciphertext_size] || p['ciphertext_size']
        hash = p[:ciphertext_sha256_b64] || p['ciphertext_sha256_b64']
        raise ArgumentError, 'each part needs part_number, ciphertext_size, ciphertext_sha256_b64' if n.nil? || size.nil? || hash.nil?

        digest = begin
          Base64.strict_decode64(hash.to_s)
        rescue ArgumentError
          raise ArgumentError, "part #{n} ciphertext_sha256_b64 must be valid base64"
        end
        raise ArgumentError, "part #{n} ciphertext_sha256_b64 must be a SHA-256 (32 bytes)" unless digest.bytesize == 32

        { part_number: n.to_i, ciphertext_size: size.to_i }
      end
    end

    def ensure_completable!(blob, now)
      raise ArgumentError, 'blob is not uploading' unless blob.status == 'uploading'
      raise ArgumentError, 'upload session expired; start a new upload with a new blob_id' if UploadSession.expired?(blob, now)
      raise ArgumentError, 'blob has no encrypted manifest — cannot be decrypted on download' if blob.encrypted_manifest.blank?
    end

    def verify_storage!(blob, stored)
      sizes = Blobs.storage_provider.list(prefix: "#{blob.storage_key}/").to_h { |o| [o.key, o.size] }
      stored.each do |part|
        actual = sizes[part.object_key]
        raise ArgumentError, "part #{part.part_number} not found in storage" if actual.nil?
        unless actual == part.ciphertext_size
          raise ArgumentError, "part #{part.part_number} size mismatch: storage has #{actual}, expected #{part.ciphertext_size}"
        end
      end
    end
  end
end
