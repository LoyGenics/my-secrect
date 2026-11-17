require 'rotp'
require 'digest'
require 'securerandom'

module Authentication
  # TOTP MFA (RFC 6238) + single-use recovery codes. Account second factor
  # only — it never unlocks the vault and never decrypts anything.
  #
  # Storage rules (never weakened):
  #   * TOTP secret — MessageEncryptor ciphertext only (salt
  #     'my-secrect mfa v1'); the plaintext secret is returned ONCE by
  #     enroll and must be shown once by the client, never stored
  #     server-side in plaintext, never logged (see filter_parameters).
  #   * Recovery codes — SHA-256 digests only; the codes are shown once
  #     at confirm/regenerate time and are single-use.
  #   * Replay: a TOTP code whose 30 s step is <= totp_last_step is
  #     rejected, even inside the ±1-step drift window.
  #   * Comparison of recovery-code digests is constant-time
  #     (ActiveSupport::SecurityUtils.secure_compare).
  module Totp
    class Error < StandardError; end
    class VerificationError < Error; end

    SALT = 'my-secrect mfa v1'
    ISSUER = 'my-secrect'
    STEP_SECONDS = 30
    DRIFT_STEPS = 1 # ±1 step accepted by ROTP, then the replay check applies
    RECOVERY_CODE_COUNT = 10
    # Unambiguous alphabet: no 0/O, 1/I/l. Codes are 'XXXX-XXXX'.
    RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

    module_function

    # Step 1: create a fresh secret, store ONLY its ciphertext, return the
    # secret + otpauth URL ONCE. Refused while MFA is already enabled
    # (disable first); re-enrolment while unconfirmed replaces the secret.
    def enroll(user:)
      raise Error, 'mfa_already_enabled' if user.mfa_enabled?
      secret = ROTP::Base32.random
      user.update!(totp_secret_ciphertext: encrypt_secret(secret), totp_confirmed_at: nil)
      { secret: secret, otpauth_url: ROTP::TOTP.new(secret, issuer: ISSUER).provisioning_uri(user.email) }
    end

    # Step 2: confirm the enrolment with a valid, non-replayed code.
    # Enables MFA and issues the recovery codes (shown once).
    def confirm(user:, code:)
      step = totp_step_for(user, code)
      raise VerificationError, 'verification failed' unless step
      raise VerificationError, 'code_replayed' if step <= (user.totp_last_step || -1)
      codes = nil
      ActiveRecord::Base.transaction do
        user.update!(mfa_enabled: true, totp_confirmed_at: Time.current, totp_last_step: step)
        codes = generate_recovery_codes(user: user)
      end
      Audit::Log.call(user: user, event_type: 'mfa_enabled')
      { mfa_enabled: true, recovery_codes: codes }
    end

    # Verify a TOTP code. On success advances totp_last_step (replay
    # protection); on failure changes no state. Returns true/false.
    def verify_code(user:, code:)
      step = totp_step_for(user, code)
      return false unless step
      return false if step <= (user.totp_last_step || -1)
      user.update!(totp_last_step: step)
      true
    end

    # Verify + consume one recovery code (single-use, row-locked,
    # constant-time digest compare). Returns true/false.
    def verify_recovery_code(user:, code:)
      digest = Digest::SHA256.hexdigest(normalize_recovery_code(code))
      consumed = false
      RecoveryCode.transaction do
        user.recovery_codes.unused.lock.each do |record|
          next unless ActiveSupport::SecurityUtils.secure_compare(record.code_digest, digest)
          record.update!(used_at: Time.current)
          consumed = true
          break
        end
      end
      Audit::Log.call(user: user, event_type: 'mfa_recovery_code_used') if consumed
      consumed
    end

    # Either second factor. Returns :totp, :recovery_code, or false.
    # TOTP is tried first (recovery codes are not 6 digits, so in
    # practice exactly one branch can match).
    def verify_second_factor(user:, code:)
      return :totp if verify_code(user: user, code: code)
      return :recovery_code if verify_recovery_code(user: user, code: code)
      false
    end

    # Disable MFA: clears the secret and ALL recovery codes.
    def disable(user:)
      ActiveRecord::Base.transaction do
        user.update!(mfa_enabled: false, totp_secret_ciphertext: nil,
                     totp_last_step: nil, totp_confirmed_at: nil)
        user.recovery_codes.delete_all
      end
      Audit::Log.call(user: user, event_type: 'mfa_disabled')
      { mfa_enabled: false }
    end

    # Generate 10 fresh recovery codes, replacing all existing ones.
    # Returns the plaintext codes ONCE — the caller must show them once
    # and never store them; only digests are persisted.
    def generate_recovery_codes(user:)
      codes = Array.new(RECOVERY_CODE_COUNT) { random_recovery_code }
      ActiveRecord::Base.transaction do
        user.recovery_codes.delete_all
        codes.each do |code|
          user.recovery_codes.create!(code_digest: Digest::SHA256.hexdigest(normalize_recovery_code(code)))
        end
      end
      codes
    end

    # Complete a login that Passkeys.verify parked with mfa_required.
    # The pending token is consumed before the second factor is checked
    # (single-use either way); on success a full session is issued.
    # NOTE: completing MFA does NOT mark the session step-up verified —
    # step-up is a separate, explicit re-verification (StepUp).
    # Device: only what the passkey step PROVED (specs/device-identity.md)
    # — an existing device (re-checked active) or a pending enrolment,
    # applied now that both factors passed. Without a proof the session is
    # unbound; the server never picks a device on its own.
    def complete_mfa_login(mfa_token:, code:, user_agent: nil, ip_address: nil)
      pending = MfaTokens.consume(mfa_token)
      raise VerificationError, 'verification failed' unless pending
      user = pending.user
      factor = verify_second_factor(user: user, code: code)
      raise VerificationError, 'verification failed' unless factor
      device = DeviceProof.device_for!(user: user, proof: pending_device_proof(pending))
      token = SessionTokens.issue(user: user, device: device, user_agent: user_agent, ip_address: ip_address)
      Audit::Log.call(user: user, device: device, event_type: 'mfa_verified', metadata: { method: factor.to_s })
      { token: token, user_id: user.id, device_id: device&.id, expires_in: SessionTokens::TTL_SECONDS }
    rescue DeviceProof::VerificationError
      raise VerificationError, 'verification failed'
    end

    def pending_device_proof(pending)
      return { device: pending.device } if pending.device
      return { enroll: pending.pending_device.symbolize_keys } if pending.pending_device.present?
      nil
    end

    # Test/support helper: decrypt a stored TOTP ciphertext. Exposed so
    # specs can build real ROTP codes from the stored secret; it is NOT
    # reachable from any controller or route.
    def decrypt_secret(ciphertext)
      SecretEncryptor.decrypt(ciphertext, salt: SALT)
    end

    # -- internals ---------------------------------------------------------

    def encrypt_secret(secret)
      SecretEncryptor.encrypt(secret, salt: SALT)
    end

    def secret_for(user)
      return nil if user.totp_secret_ciphertext.blank?
      SecretEncryptor.decrypt(user.totp_secret_ciphertext, salt: SALT)
    rescue ActiveSupport::MessageEncryptor::InvalidMessage, ActiveSupport::MessageVerifier::InvalidSignature
      nil
    end

    # Returns the 30 s step the code is valid for, or nil. ROTP#verify
    # returns the matching Time (or nil); drift is ±1 step, and the
    # caller still applies the replay check (step <= totp_last_step).
    def totp_step_for(user, code)
      secret = secret_for(user)
      return nil if secret.nil? || code.blank?
      totp = ROTP::TOTP.new(secret)
      matched = totp.verify(code.to_s.strip, drift_behind: STEP_SECONDS * DRIFT_STEPS, drift_ahead: STEP_SECONDS * DRIFT_STEPS)
      return nil unless matched
      matched_at =
        case matched
        when Time then matched
        when Numeric then Time.at(matched)
        else return nil
        end
      matched_at.to_i / STEP_SECONDS
    end

    def normalize_recovery_code(code)
      code.to_s.upcase.gsub(/[^A-Z0-9]/, '')
    end

    def random_recovery_code
      raw = Array.new(8) { RECOVERY_CODE_ALPHABET[SecureRandom.random_number(RECOVERY_CODE_ALPHABET.length)] }.join
      "#{raw[0, 4]}-#{raw[4, 4]}"
    end
  end
end
