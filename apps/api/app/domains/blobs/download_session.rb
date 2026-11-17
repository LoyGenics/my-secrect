module Blobs
  module DownloadSession
    module_function
    def call(blob:)
      raise ArgumentError, 'blob not complete' unless blob.status == 'complete'
      provider = StorageProvider.new
      {
        blob_id: blob.id,
        parts: blob.blob_parts.order(:part_number).map { |p| { part_number: p.part_number, url: provider.presigned_get(object_key: p.object_key), expires_at: Time.current + StorageProvider::PRESIGN_TTL } }
      }
    end
  end
end
