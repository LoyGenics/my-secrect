# WebAuthn relying party. Passkeys authenticate the ACCOUNT only.
# They do not unlock the vault and do not recover decryption keys.
WebAuthn.configure do |config|
  config.rp_name = ENV.fetch('WEBAUTHN_RP_NAME', 'my-secrect')
  config.rp_id = ENV.fetch('WEBAUTHN_RP_ID', 'localhost')
  config.origin = ENV.fetch('WEBAUTHN_ORIGIN', 'http://localhost:3000')
  # Verification is delegated to the `webauthn` gem in Authentication::Passkeys.
end
