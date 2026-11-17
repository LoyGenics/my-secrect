class RetentionJob < ApplicationJob
  queue_as :low
  # Retention: audit events older than 1 year are deleted; deleted items'
  # ciphertext versions older than 90 days are pruned (tombstone kept).
  # The client keeps its own local copy — server pruning never deletes
  # the only copy of live data.
  def perform
    AuditEvent.where('created_at < ?', 1.year.ago).delete_all
    Item.where.not(deleted_at: nil).where('deleted_at < ?', 90.days.ago).find_each do |item|
      item.item_versions.where('revision < ?', item.current_revision).delete_all
    end
  end
end
