# Parameter names whose VALUES are replaced by [FILTERED] wherever Rails
# shows request parameters (development/test logs, filtered_path, error
# reports, ActiveRecord#inspect). Partial, case-insensitive matches:
# `crypt` covers encrypted_payload/_item_key/_metadata/_manifest/_key and
# ciphertext_*, `_key` covers public_key/object_key, `code` covers
# recovery_code, `credential` covers the whole WebAuthn response hash.
# Production does not log parameters at all (logging.rb); this list
# is the second line of defence.
Rails.application.config.filter_parameters += %i[
  passw secret token crypt _key salt certificate otp ssn cvv cvc pin
  credential attestation client_data authenticator_data challenge signature
  code recovery manifest email
]
