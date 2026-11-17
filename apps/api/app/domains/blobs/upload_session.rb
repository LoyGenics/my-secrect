module Blobs
  module UploadSession
    MAX_BLOB_BYTES = 5 * 1024 * 1024 * 1024 # 5 GiB per blob (v1 cap; quota domain enforces per-user)
    PART_BYTES = 8 * 1024 * 1024 # 8 MiB transport parts (presigned PUTs)
    # Phase C fix (H8): part_count was uncapped — a client could request
    # millions of presigned URLs / part rows. 5 GiB at 8 MiB/part needs at
    # most 640 parts; the cap allows 1 MiB client chunks (one part each)
    # up to the 5 GiB limit with headroom. Anything above is rejected.
    MAX_PART_COUNT = 5_120
    module_function
    # Phase C fix (H8): the upload session now REQUIRES the client's
    # Vault-Key-encrypted manifest (`encrypted_manifest`, base64). The
    # manifest is where the wrapped File Key lives (see
    # packages/storage/src/upload.ts: BlobManifest.wrapped_file_key) —
    # without it a download can never be decrypted, which is exactly
    # how the old flow failed: blobs were completable with no manifest
    # and no wrapped key stored anywhere. The server stores the manifest
    # opaquely on the blob row (existing blobs.encrypted_manifest column)
    # and returns it verbatim at download time; it never decrypts it.
    # The server stores the WRAPPED key only, never a plaintext File Key.
    #
    # Quota is enforced HERE, before any part rows or presigned URLs are
    # created: current usage + this blob must fit the storage limit.
    # NOTE: BlobsController must forward params[:encrypted_manifest].
    def call(vault:, blob_id:, part_count:, ciphertext_size:, encrypted_manifest: nil)
      raise ArgumentError, 'blob_id required' if blob_id.blank?
      raise ArgumentError, 'ciphertext_size must be > 0' if ciphertext_size.to_i < 1
      raise ArgumentError, 'ciphertext_size too large' if ciphertext_size.to_i > MAX_BLOB_BYTES
      raise ArgumentError, 'part_count must be >= 1' if part_count.to_i < 1
      raise ArgumentError, "part_count exceeds maximum #{MAX_PART_COUNT}" if part_count.to_i > MAX_PART_COUNT
      raise ArgumentError, 'part_count inconsistent with ciphertext_size' if ciphertext_size.to_i > part_count.to_i * PART_BYTES
      raise ArgumentError, 'encrypted_manifest required (Vault-Key-encrypted manifest carrying the wrapped File Key)' if encrypted_manifest.blank?
      begin
        manifest_bytes = Base64.strict_decode64(encrypted_manifest.to_s)
      rescue ArgumentError
        raise ArgumentError, 'encrypted_manifest must be valid base64'
      end
      raise ArgumentError, 'encrypted_manifest is empty' if manifest_bytes.empty?
      user = vault.owner
      if Billing::Quota.usage_for(user: user)[:storage_bytes] + ciphertext_size.to_i > Billing::Quota::STORAGE_LIMIT_BYTES
        raise ArgumentError, 'storage quota exceeded'
      end
      provider = StorageProvider.new
      vault.transaction do
        blob = vault.blobs.create!(id: blob_id, storage_key: "vaults/#{vault.id}/blobs/#{blob_id}", ciphertext_size: ciphertext_size.to_i, encrypted_manifest: manifest_bytes, status: 'uploading')
        parts = (1..part_count.to_i).map do |n|
          object_key = "#{blob.storage_key}/part-#{format('%05d', n)}"
          blob.blob_parts.create!(part_number: n, object_key: object_key, ciphertext_size: 0)
          { part_number: n, url: provider.presigned_put(object_key: object_key), object_key: object_key, expires_at: Time.current + StorageProvider::PRESIGN_TTL }
        end
        { blob_id: blob.id, storage_key: blob.storage_key, parts: parts }
      end
    end
  end
end
