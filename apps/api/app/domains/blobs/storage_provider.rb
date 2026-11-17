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
  #
  # Two endpoints, two jobs (non-AWS stores such as MinIO):
  #   S3_ENDPOINT        server-side calls (HEAD, DELETE); may be internal,
  #                      e.g. http://minio:9000.
  #   S3_PUBLIC_ENDPOINT used ONLY to sign presigned URLs given to clients.
  #                      SigV4 signs the Host header, so it must be the exact
  #                      origin clients reach (e.g. https://s3.example.com).
  #                      Required whenever S3_ENDPOINT is used (set it equal to
  #                      S3_ENDPOINT only if clients can reach that address).
  #                      Must NOT be set with S3_USE_AWS_ENDPOINT=true.
  class StorageProvider
    PRESIGN_TTL = 300

    class ConfigError < StandardError; end

    REQUIRED = %w[S3_ACCESS_KEY S3_SECRET_KEY S3_BUCKET S3_REGION].freeze

    def self.fetch_required(env, name)
      value = env[name]
      raise ConfigError, "#{name} is required but not set" if value.nil? || value.strip.empty?
      value
    end

    def self.validate_endpoint!(env, name)
      value = fetch_required(env, name)
      uri = begin
        URI.parse(value.strip)
      rescue URI::InvalidURIError
        raise ConfigError, "#{name} must be an http(s) URL"
      end
      unless uri.is_a?(URI::HTTP) && uri.host && !uri.host.empty?
        raise ConfigError, "#{name} must be an http(s) URL with a host"
      end
      unless ['', '/'].include?(uri.path.to_s) && uri.query.nil? && uri.userinfo.nil?
        raise ConfigError, "#{name} must be a bare origin (scheme://host[:port]) with no path, query or credentials"
      end
      value.strip
    end

    def self.config_from(env)
      cfg = REQUIRED.to_h { |n| [n, fetch_required(env, n)] }
      if env['S3_USE_AWS_ENDPOINT'] == 'true'
        unless env['S3_PUBLIC_ENDPOINT'].nil? || env['S3_PUBLIC_ENDPOINT'].strip.empty?
          raise ConfigError, 'S3_PUBLIC_ENDPOINT must not be set with S3_USE_AWS_ENDPOINT=true'
        end
        cfg['S3_ENDPOINT'] = nil
        cfg['S3_PUBLIC_ENDPOINT'] = nil
      else
        cfg['S3_ENDPOINT'] = validate_endpoint!(env, 'S3_ENDPOINT')
        cfg['S3_PUBLIC_ENDPOINT'] = validate_endpoint!(env, 'S3_PUBLIC_ENDPOINT')
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
      # Presigning is a local computation (no network). Sign against the
      # PUBLIC endpoint so the Host baked into the signature is the one
      # external clients actually send.
      presign_client = if cfg['S3_PUBLIC_ENDPOINT']
        Aws::S3::Client.new(**opts, endpoint: cfg['S3_PUBLIC_ENDPOINT'])
      else
        @client
      end
      @presigner = Aws::S3::Presigner.new(client: presign_client)
      @bucket = cfg['S3_BUCKET']
    end
    def presigned_put(object_key:) = @presigner.presigned_url(:put_object, bucket: @bucket, key: object_key, expires_in: PRESIGN_TTL)
    def presigned_get(object_key:) = @presigner.presigned_url(:get_object, bucket: @bucket, key: object_key, expires_in: PRESIGN_TTL)
    def delete(object_key:) = @client.delete_object(bucket: @bucket, key: object_key)
    def head(object_key:) = @client.head_object(bucket: @bucket, key: object_key)
  end
end
