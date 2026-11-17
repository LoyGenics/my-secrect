module Sharing
  # Binary fields travel as standard base64 and are stored as raw bytes.
  # Sizes are checked so a client bug cannot store junk or huge blobs; the
  # server never interprets the bytes.
  module Wire
    PUBLIC_KEY_BYTES = 32
    # nonce (24) + crypto_box_easy(32-byte Share Key) (32 + 16 MAC)
    WRAPPED_SHARE_KEY_BYTES = 72
    # nonce (24) + XChaCha20-Poly1305 tag (16) + at least one plaintext byte
    MIN_CIPHERTEXT_BYTES = 41
    MAX_PAYLOAD_BYTES = 1_048_576
    MAX_SMALL_CIPHERTEXT_BYTES = 4096

    module_function

    def decode!(value, field:, min:, max:)
      raise Failure.invalid("#{field} is required") if value.blank?
      raise Failure.invalid("#{field} must be base64") unless value.is_a?(String)

      bytes = strict_decode(value, field)
      raise Failure.invalid("#{field} has an invalid length") unless bytes.bytesize.between?(min, max)

      bytes
    end

    def public_key!(value, field:) = decode!(value, field: field, min: PUBLIC_KEY_BYTES, max: PUBLIC_KEY_BYTES)
    def wrapped_share_key!(value) = decode!(value, field: 'encrypted_item_key', min: WRAPPED_SHARE_KEY_BYTES, max: WRAPPED_SHARE_KEY_BYTES)
    def payload!(value) = decode!(value, field: 'encrypted_payload', min: MIN_CIPHERTEXT_BYTES, max: MAX_PAYLOAD_BYTES)
    def small_ciphertext!(value, field:) = decode!(value, field: field, min: MIN_CIPHERTEXT_BYTES, max: MAX_SMALL_CIPHERTEXT_BYTES)

    def encode(bytes) = bytes && Base64.strict_encode64(bytes)

    def strict_decode(value, field)
      Base64.strict_decode64(value)
    rescue ArgumentError
      raise Failure.invalid("#{field} must be base64")
    end
  end
end
