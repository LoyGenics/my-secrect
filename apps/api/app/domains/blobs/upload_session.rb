module Blobs
  module UploadSession
    MAX_BLOB_BYTES = 5 * 1024 * 1024 * 1024 # 5 GiB per blob (v1 cap; quota domain enforces per-user)
    PART_BYTES = 8 * 1024 * 1024 # 8 MiB parts
    module_function
    def call(vault:, blob_id:, part_count:, ciphertext_size:)
      raise ArgumentError, 'ciphertext_size too large' if ciphertext_size.to_i > MAX_BLOB_BYTES
      raise ArgumentError, 'part_count must be >= 1' if part_count.to_i < 1
      provider = StorageProvider.new
      blob = vault.blobs.create!(id: blob_id, storage_key: "vaults/#{vault.id}/blobs/#{blob_id}", ciphertext_size: ciphertext_size.to_i, status: 'uploading')
      parts = (1..part_count.to_i).map do |n|
        object_key = "#{blob.storage_key}/part-#{format('%05d', n)}"
        blob.blob_parts.create!(part_number: n, object_key: object_key, ciphertext_size: 0)
        { part_number: n, url: provider.presigned_put(object_key: object_key), object_key: object_key, expires_at: Time.current + StorageProvider::PRESIGN_TTL }
      end
      { blob_id: blob.id, storage_key: blob.storage_key, parts: parts }
    end
  end
end
