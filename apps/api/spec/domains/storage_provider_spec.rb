require 'rails_helper'

RSpec.describe Blobs::StorageProvider do
  let(:full_env) do
    { 'S3_ENDPOINT' => 'http://minio.internal:9000', 'S3_REGION' => 'us-east-1', 'S3_BUCKET' => 'b',
      'S3_ACCESS_KEY' => 'AK-spec-value', 'S3_SECRET_KEY' => 'SK-spec-value' }
  end

  it 'builds with a complete explicit config' do
    expect { described_class.new(env: full_env) }.not_to raise_error
  end

  %w[S3_ENDPOINT S3_ACCESS_KEY S3_SECRET_KEY S3_BUCKET S3_REGION].each do |name|
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

  it 'allows a missing endpoint only with explicit S3_USE_AWS_ENDPOINT=true' do
    env = full_env.except('S3_ENDPOINT')
    expect { described_class.new(env: env) }.to raise_error(described_class::ConfigError, /S3_ENDPOINT/)
    expect { described_class.new(env: env.merge('S3_USE_AWS_ENDPOINT' => 'true')) }.not_to raise_error
  end

  it 'has no hardcoded weak defaults in the source' do
    src = File.read(Rails.root.join('app/domains/blobs/storage_provider.rb'))
    expect(src).not_to match(/minio123|localhost:9000/)
  end
end
