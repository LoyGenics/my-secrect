# Re-apply account deletions after a backup restore. The runbook is in
# app/domains/accounts/tombstones.rb; in short:
#   1. before restoring:  bin/rails accounts:tombstones:export > tombstones.jsonl
#      (or collect the "[account_tombstone]" log lines if the DB is lost)
#   2. restore database + object storage
#   3. bin/rails "accounts:tombstones:import[tombstones.jsonl]"
#      bin/rails accounts:tombstones:reapply      (before serving traffic)
namespace :accounts do
  namespace :tombstones do
    desc 'Print every account tombstone as JSON lines (run on the database you are about to replace)'
    task export: :environment do
      Accounts::Tombstones.export.each { |entry| puts entry.to_json }
    end

    desc 'Import tombstones from a file of JSON lines or [account_tombstone] log lines'
    task :import, [:path] => :environment do |_task, args|
      entries = Accounts::Tombstones.parse(File.readlines(args.fetch(:path)))
      puts "imported #{Accounts::Tombstones.import!(entries)} new tombstones (#{entries.size} read)"
    end

    desc 'Delete every restored account that has a tombstone (rows and storage objects)'
    task reapply: :environment do
      puts "re-deleted #{Accounts::Tombstones.reapply!} accounts"
    end
  end
end
