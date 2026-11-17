# In-memory adapter implementing the full Blobs::StorageProvider interface.
# Used by specs instead of mocking the method under test.
class InMemoryStorage
  attr_reader :objects, :delete_log
  attr_accessor :fail_deletes_for

  def initialize
    @objects = {}
    @modified = {}
    @delete_log = []
    @fail_deletes_for = []
  end

  def put(key, bytes, at: Time.current)
    @modified[key] = at
    @objects[key] = bytes
  end

  def presigned_put(object_key:, content_length:) = "https://s3.spec.test/put/#{object_key}?len=#{content_length}"
  def presigned_get(object_key:) = "https://s3.spec.test/get/#{object_key}"

  def head(object_key:)
    raise Aws::S3::Errors::NotFound.new(nil, 'not found') unless @objects.key?(object_key)

    Struct.new(:content_length).new(@objects[object_key].bytesize)
  end

  def list(prefix:)
    @objects.keys.select { |k| k.start_with?(prefix) }.sort.map do |k|
      Blobs::StoredObject.new(key: k, size: @objects[k].bytesize, last_modified: @modified[k])
    end
  end

  def delete(object_key:)
    raise Aws::S3::Errors::InternalError.new(nil, 'boom') if @fail_deletes_for.include?(object_key)

    @delete_log << object_key
    @modified.delete(object_key)
    @objects.delete(object_key) # idempotent like S3
  end
end
