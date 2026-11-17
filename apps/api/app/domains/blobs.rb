# The Blobs namespace. Defined explicitly (not as a Zeitwerk implicit
# namespace) so `Blobs.storage_provider` exists as soon as `Blobs` is
# referenced — e.g. by Accounts::Delete — not only after
# Blobs::StorageProvider happened to be loaded.
module Blobs
  # Seam for specs: any object implementing the StorageProvider interface
  # (presigned_put/presigned_get/delete/head/list) may be installed here.
  # Nil (production default) means a real StorageProvider built from ENV.
  class << self
    attr_writer :storage_provider

    def storage_provider = @storage_provider || StorageProvider.new
  end
end
