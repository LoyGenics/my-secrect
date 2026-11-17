require 'base64'

module Authentication
  # Server-side encryption for small account secrets (TOTP secrets,
  # recovery challenges). Key derived from Rails secret_key_base via
  # ActiveSupport::KeyGenerator (32 bytes) + MessageEncryptor AES-256-GCM.
  # Each use has its own salt so a ciphertext for one purpose cannot be
  # replayed as another. This encrypts ACCOUNT secrets only — it never
  # touches vault content and never decrypts anything vault-related.
  module SecretEncryptor
    module_function

    def encryptor(salt:)
      key = ActiveSupport::KeyGenerator.new(Rails.application.secret_key_base).generate_key(salt, 32)
      ActiveSupport::MessageEncryptor.new(key)
    end

    def encrypt(plaintext, salt:)
      encryptor(salt: salt).encrypt_and_sign(plaintext)
    end

    def decrypt(ciphertext, salt:)
      encryptor(salt: salt).decrypt_and_verify(ciphertext)
    end

    # Accepts standard or URL-safe base64, with or without padding.
    # Raises ArgumentError on garbage input (callers fail closed).
    def decode_base64_loose(str)
      s = str.to_s.strip.tr('-_', '+/')
      s += '=' * ((4 - (s.length % 4)) % 4)
      Base64.strict_decode64(s)
    end

    def encode_base64url(bytes)
      Base64.urlsafe_encode64(bytes, padding: false)
    end
  end
end
