module Blobs
  module Complete
    module_function
    # The client confirms all parts uploaded. Server checks counts only;
    # chunk authenticity is verified by the CLIENT from the encrypted manifest.
    def call(blob:)
      raise ArgumentError, 'blob has no parts' if blob.blob_parts.empty?
      blob.update!(status: 'complete')
      blob
    end
  end
end
