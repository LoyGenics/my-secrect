require 'digest'
require 'json'

module Accounts
  # Account deletion tombstones: the minimal record that an account was
  # deleted, kept after the user row is gone, so a deletion can be
  # re-applied when a backup taken BEFORE it is restored (the restore
  # brings the account's rows and ciphertext objects back).
  #
  # A tombstone is SHA-256("my-secrect/account-tombstone/v1:" + user id) and
  # the deletion time — no email, no other PII. The user id is a random
  # UUID, so the digest cannot be enumerated; it only matches a row that
  # carries that exact id.
  #
  # Two copies, because a restore replaces the database:
  #   * the account_tombstones table (written in the deletion transaction);
  #   * one log line per deletion, "[account_tombstone] user_id_digest=…
  #     deleted_at=…", for when the database itself is lost.
  #
  # Restore runbook (rake tasks in lib/tasks/account_tombstones.rake):
  #   1. BEFORE restoring, export the tombstones of the database being
  #      replaced: `bin/rails accounts:tombstones:export > tombstones.jsonl`.
  #      If that database is gone, collect the "[account_tombstone]" log
  #      lines written since the backup was taken instead.
  #   2. Restore the backup (database + object storage).
  #   3. `bin/rails "accounts:tombstones:import[tombstones.jsonl]"` (JSON
  #      lines and the log-line format are both accepted), then
  #      `bin/rails accounts:tombstones:reapply`, which deletes every
  #      restored account that has a tombstone — rows AND storage objects,
  #      through Accounts::Delete — before the API takes traffic again.
  module Tombstones
    LABEL = 'my-secrect/account-tombstone/v1:'.freeze
    LOG_PREFIX = '[account_tombstone]'.freeze
    LOG_LINE = /\[account_tombstone\] user_id_digest=(\h{64}) deleted_at=(\S+)/

    module_function

    def digest(user_id) = Digest::SHA256.hexdigest("#{LABEL}#{user_id}")

    # Called inside the deletion transaction, under the user row lock
    # (Accounts::Delete). Keeps an existing tombstone (re-applied deletion).
    def record!(user:, at: Time.current)
      AccountTombstone.find_or_create_by!(user_id_digest: digest(user.id)) { |t| t.deleted_at = at }
    end

    def log_line(tombstone)
      "#{LOG_PREFIX} user_id_digest=#{tombstone.user_id_digest} deleted_at=#{tombstone.deleted_at.utc.iso8601(6)}"
    end

    def export
      AccountTombstone.order(:deleted_at).pluck(:user_id_digest, :deleted_at).map do |digest, deleted_at|
        { 'user_id_digest' => digest, 'deleted_at' => deleted_at.utc.iso8601(6) }
      end
    end

    # One entry per line: a JSON object from `export`, or a log line.
    # Raises ArgumentError on anything else. Returns the parsed entries.
    def parse(lines)
      lines.map(&:strip).reject(&:empty?).map do |line|
        if (match = LOG_LINE.match(line))
          { 'user_id_digest' => match[1], 'deleted_at' => match[2] }
        else
          JSON.parse(line).slice('user_id_digest', 'deleted_at')
        end
      rescue JSON::ParserError
        raise ArgumentError, 'not a tombstone line'
      end
    end

    # Idempotent: existing tombstones are kept. Returns how many were new.
    def import!(entries)
      rows = entries.map do |entry|
        digest = entry['user_id_digest'].to_s
        raise ArgumentError, 'invalid tombstone digest' unless digest.match?(/\A\h{64}\z/)
        { user_id_digest: digest, deleted_at: Time.iso8601(entry['deleted_at'].to_s) }
      end
      return 0 if rows.empty?
      AccountTombstone.insert_all(rows, unique_by: :user_id_digest).length
    end

    # Delete every account whose id has a tombstone. Returns the count.
    # The digest is not stored on users, so ids are hashed here in Ruby —
    # a one-off maintenance pass after a restore, not a request path.
    def reapply!
      tombstoned = AccountTombstone.pluck(:user_id_digest).to_set
      ids = User.pluck(:id).select { |id| tombstoned.include?(digest(id)) }
      User.where(id: ids).find_each { |user| Accounts::Delete.call(user: user) }
      ids.size
    end
  end
end
