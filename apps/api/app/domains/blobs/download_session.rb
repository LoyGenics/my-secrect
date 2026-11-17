module Blobs
  module DownloadSession
    module_function
    # Phase C fix (H8): a download is only decryptable if the client gets
    # back (a) the Vault-Key-encrypted manifest — which carries the
    # wrapped File Key (packages/storage BlobManifest.wrapped_file_key)
    # — and (b) the ciphertext chunks. The old response returned only
    # presigned part URLs, so downloads could never be decrypted.
    # This response now returns the stored encrypted_manifest (base64,
    # opaque to the server) alongside the part URLs. The client flow is:
    #   manifest = decryptManifest(encrypted_manifest, vaultKey)
    #   fileKey  = unwrapFileKey(manifest.wrapped_file_key, vaultKey)
    #   bytes    = decryptChunks(downloaded chunks, manifest, fileKey)
    # Every chunk hash + AEAD tag is verified client-side against the
    # manifest before reassembly. The server stores/returns the WRAPPED
    # key only, never a plaintext File Key. Blobs completed before Phase C
    # have no manifest and are refused here (honest failure, not a
    # silently undecryptable download).
    def call(blob:)
      raise ArgumentError, 'blob not complete' unless blob.status == 'complete'
      raise ArgumentError, 'blob has no encrypted manifest — cannot be decrypted on download' if blob.encrypted_manifest.blank?
      provider = Blobs.storage_provider
      {
        blob_id: blob.id,
        status: blob.status,
        ciphertext_size: blob.ciphertext_size,
        encrypted_manifest: Base64.strict_encode64(blob.encrypted_manifest),
        parts: blob.blob_parts.order(:part_number).map { |p| { part_number: p.part_number, ciphertext_size: p.ciphertext_size, url: provider.presigned_get(object_key: p.object_key), expires_at: Time.current + StorageProvider::PRESIGN_TTL } }
      }
    end
  end
end
