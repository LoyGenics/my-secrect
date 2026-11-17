module Blobs
  module Complete
    module_function
    # Phase C fix (H8): Complete used to check only that *some* part rows
    # existed, then marked the blob complete — no manifest, no wrapped
    # File Key, no hash/existence check. Such a blob could never be
    # downloaded + decrypted. Complete now verifies, before marking
    # anything complete:
    #   1. the blob is still 'uploading' (no double-complete, no
    #      completing a failed/orphaned blob);
    #   2. a Vault-Key-encrypted manifest is stored on the blob row
    #      (it carries the wrapped File Key — see UploadSession);
    #   3. the client-reported `parts` list covers every stored part
    #      exactly once (contiguous 1..N), each with a plausible size
    #      and a well-formed SHA-256 (base64, 32 bytes) of its ciphertext;
    #   4. every part object actually EXISTS in storage (S3/R2/MinIO
    #      HEAD) with the reported size.
    # The server cannot verify the manifest's *contents* (it is encrypted
    # with the Vault Key) or re-derive chunk hashes from it — the client
    # does that at download time (packages/storage decryptChunks checks
    # every chunk hash + AEAD tag against the manifest). The one gap
    # left: part hashes are verified at Complete time but NOT persisted
    # (no blob_parts.ciphertext_sha256 column yet) — a follow-up
    # migration should add it so downloads can be re-checked server-side.
    # A storage outage therefore fails Complete loudly instead of
    # marking a blob complete that is not really there. That is intended.
    # NOTE: BlobsController must forward params[:parts].
    def call(blob:, parts: nil)
      raise ArgumentError, 'blob is not uploading' unless blob.status == 'uploading'
      raise ArgumentError, 'blob has no encrypted manifest — cannot be decrypted on download' if blob.encrypted_manifest.blank?
      raise ArgumentError, 'blob has no parts' if blob.blob_parts.empty?
      raise ArgumentError, 'parts list required (part_number, ciphertext_size, ciphertext_sha256_b64 per part)' if parts.blank?
      stored = blob.blob_parts.order(:part_number).to_a
      reported = parts.map do |p|
        n = p[:part_number] || p['part_number']
        size = p[:ciphertext_size] || p['ciphertext_size']
        hash = p[:ciphertext_sha256_b64] || p['ciphertext_sha256_b64']
        raise ArgumentError, 'each part needs part_number, ciphertext_size, ciphertext_sha256_b64' if n.nil? || size.nil? || hash.nil?
        { part_number: n.to_i, ciphertext_size: size.to_i, ciphertext_sha256_b64: hash.to_s }
      end
      raise ArgumentError, "parts count mismatch: expected #{stored.size}, got #{reported.size}" unless reported.size == stored.size
      expected_numbers = (1..stored.size).to_a
      unless reported.map { |p| p[:part_number] }.sort == expected_numbers
        raise ArgumentError, 'part numbers must be contiguous 1..N with no gaps or duplicates'
      end
      reported.each do |p|
        raise ArgumentError, "part #{p[:part_number]} ciphertext_size invalid" if p[:ciphertext_size] < 1 || p[:ciphertext_size] > UploadSession::PART_BYTES
        begin
          digest = Base64.strict_decode64(p[:ciphertext_sha256_b64])
        rescue ArgumentError
          raise ArgumentError, "part #{p[:part_number]} ciphertext_sha256_b64 must be valid base64"
        end
        raise ArgumentError, "part #{p[:part_number]} ciphertext_sha256_b64 must be a SHA-256 (32 bytes)" unless digest.bytesize == 32
      end
      provider = StorageProvider.new
      stored.each do |stored_part|
        reported_part = reported.find { |p| p[:part_number] == stored_part.part_number }
        begin
          head = provider.head(object_key: stored_part.object_key)
        rescue Aws::S3::Errors::NotFound
          raise ArgumentError, "part #{stored_part.part_number} not found in storage"
        end
        actual_size = head&.content_length
        if actual_size && actual_size.to_i != reported_part[:ciphertext_size]
          raise ArgumentError, "part #{stored_part.part_number} size mismatch: storage has #{actual_size}, client reported #{reported_part[:ciphertext_size]}"
        end
      end
      blob.transaction do
        stored.each do |stored_part|
          reported_part = reported.find { |p| p[:part_number] == stored_part.part_number }
          stored_part.update!(ciphertext_size: reported_part[:ciphertext_size])
        end
        blob.update!(status: 'complete', ciphertext_size: reported.sum { |p| p[:ciphertext_size] })
      end
      blob
    end
  end
end
