require 'rails_helper'

RSpec.describe Blobs::StorageProvider do
  let(:full_env) do
    { 'S3_ENDPOINT' => 'http://minio.internal:9000', 'S3_PUBLIC_ENDPOINT' => 'https://s3.vault.test:8443', 'S3_REGION' => 'us-east-1', 'S3_BUCKET' => 'b',
      'S3_ACCESS_KEY' => 'AK-spec-value', 'S3_SECRET_KEY' => 'SK-spec-value' }
  end

  it 'builds with a complete explicit config' do
    expect { described_class.new(env: full_env) }.not_to raise_error
  end

  %w[S3_ENDPOINT S3_PUBLIC_ENDPOINT S3_ACCESS_KEY S3_SECRET_KEY S3_BUCKET S3_REGION].each do |name|
    it "fails closed naming #{name} when it is missing" do
      expect { described_class.new(env: full_env.except(name)) }
        .to raise_error(described_class::ConfigError, /#{name} is required/)
    end

    it "fails closed when #{name} is blank" do
      expect { described_class.new(env: full_env.merge(name => '  ')) }
        .to raise_error(described_class::ConfigError, /#{name}/)
    end
  end

  it 'never includes configured values in the error message' do
    env = full_env.except('S3_BUCKET')
    expect { described_class.new(env: env) }.to raise_error(described_class::ConfigError) { |e|
      expect(e.message).not_to include('AK-spec-value')
      expect(e.message).not_to include('SK-spec-value')
    }
  end

  it 'refuses a missing endpoint unless S3_USE_AWS_ENDPOINT=true' do
    expect { described_class.new(env: full_env.except('S3_ENDPOINT')) }.to raise_error(described_class::ConfigError, /S3_ENDPOINT/)
  end

  it 'allows a missing endpoint only with explicit S3_USE_AWS_ENDPOINT=true' do
    env = full_env.except('S3_ENDPOINT', 'S3_PUBLIC_ENDPOINT')
    expect { described_class.new(env: env.merge('S3_USE_AWS_ENDPOINT' => 'true')) }.not_to raise_error
  end

  it 'refuses S3_PUBLIC_ENDPOINT together with S3_USE_AWS_ENDPOINT=true' do
    env = full_env.except('S3_ENDPOINT').merge('S3_USE_AWS_ENDPOINT' => 'true')
    expect { described_class.new(env: env) }.to raise_error(described_class::ConfigError, /S3_PUBLIC_ENDPOINT must not be set/)
  end

  it 'does not fall back to S3_ENDPOINT when S3_PUBLIC_ENDPOINT is missing (would leak an internal host into URLs)' do
    expect { described_class.new(env: full_env.except('S3_PUBLIC_ENDPOINT')) }
      .to raise_error(described_class::ConfigError, /S3_PUBLIC_ENDPOINT is required/)
  end

  ['not a url', 'ftp://s3.example.com', 'https://s3.example.com/bucket', 'https://u:p@s3.example.com', 'https://'].each do |bad|
    it "rejects malformed S3_PUBLIC_ENDPOINT #{bad.inspect}" do
      expect { described_class.new(env: full_env.merge('S3_PUBLIC_ENDPOINT' => bad)) }
        .to raise_error(described_class::ConfigError, /S3_PUBLIC_ENDPOINT/)
    end
  end

  describe 'presigned URLs' do
    let(:provider) { described_class.new(env: full_env) }

    it 'are signed against the PUBLIC endpoint host, never the internal one' do
      %i[presigned_put presigned_get].each do |m|
        url = URI(provider.public_send(m, object_key: 'vaults/v/blobs/b/part-00001'))
        expect(url.scheme).to eq('https')
        expect(url.host).to eq('s3.vault.test')
        expect(url.port).to eq(8443)
        expect(url.path).to eq('/b/vaults/v/blobs/b/part-00001')
        expect(url.to_s).not_to include('minio.internal')
        expect(url.query).to include('X-Amz-Signature=')
      end
    end

    it 'sign the Host header (host-bound SigV4) so a different host would not validate' do
      url = URI(provider.presigned_put(object_key: 'k'))
      expect(CGI.parse(url.query)['X-Amz-SignedHeaders'].first).to include('host')
    end
  end

  it 'has no hardcoded weak defaults in the source' do
    src = File.read(Rails.root.join('app/domains/blobs/storage_provider.rb'))
    expect(src).not_to match(/minio123|localhost:9000/)
  end
end

RSpec.describe 'production boot check' do
  it 'config_from raises (used by config/initializers/storage_config.rb in production) when S3 config is absent' do
    expect { Blobs::StorageProvider.config_from({}) }.to raise_error(Blobs::StorageProvider::ConfigError, /S3_ACCESS_KEY/)
    expect(File.read(Rails.root.join('config/initializers/storage_config.rb'))).to match(/config_from\(ENV\) if Rails\.env\.production\?/)
  end
end
