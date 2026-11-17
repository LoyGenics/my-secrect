require 'securerandom'
# Test-only, explicit storage config. The production code has no defaults,
# so the suite supplies its own throwaway values (random credentials, an
# unreachable-by-design endpoint). Nothing here is a real secret.
ENV['S3_ENDPOINT'] = 'http://127.0.0.1:9' # discard port; specs never hit the network unless they inject a stub
ENV['S3_PUBLIC_ENDPOINT'] = 'https://s3.spec.test' # public (presign-only) origin
ENV['S3_REGION'] = 'us-east-1'
ENV['S3_BUCKET'] = 'spec-bucket'
ENV['S3_ACCESS_KEY'] = "spec#{SecureRandom.hex(8)}"
ENV['S3_SECRET_KEY'] = SecureRandom.hex(16)

# No network in unit/request specs: every Aws::S3::Client built by the app
# is an SDK stub client. Specs that assert on storage calls build their own
# stub client and inject it (see account_deletion_storage_spec.rb).
Aws.config.update(stub_responses: true)
