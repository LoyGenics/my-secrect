module Blobs
  # One object in storage as StorageProvider#list reports it.
  StoredObject = Struct.new(:key, :size, :last_modified, keyword_init: true)
end
