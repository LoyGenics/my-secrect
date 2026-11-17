require 'aws-sdk-s3'

module Blobs
  # ONE StorageProvider per deployment (S3 / R2 / MinIO — all S3-compatible).
  # Per-user storage is deferred (migration/integrity/backup get complex).
  # Rails only signs short-lived (5 min) presigned URLs; the client uploads
  # ciphertext directly. Rails never sees file plaintext.
  #
  # Fail closed: there are NO defaults for credentials, bucket, region or
  # endpoint. A missing/blank variable raises ConfigError naming the
  # variable (never its value). S3_ENDPOINT may be omitted only for real
  # AWS S3, and only by explicitly setting S3_USE_AWS_ENDPOINT=true.
  class StorageProvider
    PRESIGN_TTL = 300

    class ConfigError < StandardError; end

    REQUIRED = %w[S3_ACCESS_KEY S3_SECRET_KEY S3_BUCKET S3_REGION].freeze

    def self.fetch_required(env, name)
      value = env[name]
      raise ConfigError, "#{name} is required but not set" if value.nil? || value.strip.empty?
      value
    end

    def self.config_from(env)
      cfg = REQUIRED.to_h { |n| [n, fetch_required(env, n)] }
      if env['S3_USE_AWS_ENDPOINT'] == 'true'
        cfg['S3_ENDPOINT'] = nil
      else
        cfg['S3_ENDPOINT'] = fetch_required(env, 'S3_ENDPOINT')
      end
      cfg
    end

    def initialize(env: ENV)
      cfg = self.class.config_from(env)
      opts = {
        region: cfg['S3_REGION'],
        access_key_id: cfg['S3_ACCESS_KEY'],
        secret_access_key: cfg['S3_SECRET_KEY']
      }
      if cfg['S3_ENDPOINT']
        opts[:endpoint] = cfg['S3_ENDPOINT']
        opts[:force_path_style] = true
      end
      @client = Aws::S3::Client.new(**opts)
      @presigner = Aws::S3::Presigner.new(client: @client)
      @bucket = cfg['S3_BUCKET']
    end
    def presigned_put(object_key:) = @presigner.presigned_url(:put_object, bucket: @bucket, key: object_key, expires_in: PRESIGN_TTL)
    def presigned_get(object_key:) = @presigner.presigned_url(:get_object, bucket: @bucket, key: object_key, expires_in: PRESIGN_TTL)
    def delete(object_key:) = @client.delete_object(bucket: @bucket, key: object_key)
    def head(object_key:) = @client.head_object(bucket: @bucket, key: object_key)
  end
end
