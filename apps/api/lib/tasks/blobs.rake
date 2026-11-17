namespace :blobs do
  desc 'Delete expired upload sessions and orphan ciphertext objects (OrphanBlobCleanupJob). Run periodically.'
  task cleanup: :environment do
    puts OrphanBlobCleanupJob.perform_now.to_json
  end
end
