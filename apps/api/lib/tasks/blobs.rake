namespace :blobs do
  desc 'Delete expired upload sessions and orphan ciphertext objects now (OrphanBlobCleanupJob; the worker also runs it hourly).'
  task cleanup: :environment do
    puts OrphanBlobCleanupJob.new.perform.to_json
  end
end
