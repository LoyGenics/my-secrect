require 'aws-sdk-s3'

module Blobs
  # ONE StorageProvider per deployment (S3 / R2 / MinIO — all S3-compatible).
  # Per-user storage is deferred (migration/integrity/backup get complex).
  # Rails only signs short-lived (5 min) presigned URLs; the client uploads
  # ciphertext directly. Rails never sees file plaintext.
  class StorageProvider
    PRESIGN_TTL = 300
    def initialize
      @client = Aws::S3::Client.new(
        endpoint: ENV.fetch('S3_ENDPOINT', 'http://localhost:9000'),
        region: ENV.fetch('S3_REGION', 'us-east-1'),
        access_key_id: ENV.fetch('S3_ACCESS_KEY', 'minio'),
        secret_access_key: ENV.fetch('S3_SECRET_KEY', 'minio123'),
        force_path_style: true
      )
      @presigner = Aws::S3::Presigner.new(client: @client)
      @bucket = ENV.fetch('S3_BUCKET', 'vault-blobs')
    end
    def presigned_put(object_key:) = @presigner.presigned_url(:put_object, bucket: @bucket, key: object_key, expires_in: PRESIGN_TTL)
    def presigned_get(object_key:) = @presigner.presigned_url(:get_object, bucket: @bucket, key: object_key, expires_in: PRESIGN_TTL)
    def delete(object_key:) = @client.delete_object(bucket: @bucket, key: object_key)
    def head(object_key:) = @client.head_object(bucket: @bucket, key: object_key)
  end
end
