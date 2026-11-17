module Api
  module V1
    # Recovery: account recovery only. The server can help a user prove
    # ownership of an ACCOUNT (Ed25519 signature over a stored challenge
    # with a registered recovery key); it can never recover a lost vault key.
    # See specs/recovery-protocol.md — no backdoor, by design.
    class RecoveryController < ApplicationController
      skip_before_action :authenticate_request!, only: %i[create_challenge verify]

      # POST /v1/recovery/challenges — body: { email:, kind: 'passphrase'|'trusted_device'|'recovery_key' }
      # Returns a single-use challenge (5 min) + challenge_id. Unknown
      # emails get the same shape with a random unpersisted challenge and
      # a nil challenge_id — no existence leak.
      def create_challenge
        challenge = Recovery::Challenge.call(email: params[:email], kind: params[:kind] || 'recovery_key')
        render json: challenge, status: :created
      end

      # POST /v1/recovery/verify — body: { challenge_id:, email:, signature: }
      # signature is base64 (standard or URL-safe) of the Ed25519 signature
      # over the raw challenge bytes. On success issues a 15-minute
      # recovery session (recovery_session: true). Any failure is the same
      # generic 401 — no detail is leaked. Rate-limited (rack_attack).
      def verify
        result = Recovery::Verify.verify(
          challenge_id: params[:challenge_id], email: params[:email],
          signature_b64: params[:signature] || params[:signature_b64],
          user_agent: request.user_agent, ip_address: request.remote_ip
        )
        render json: result, status: :ok
      rescue Recovery::Verify::VerificationError
        render json: { error: 'verification_failed' }, status: :unauthorized
      end

      # GET /v1/recovery/verifiers — registered recovery verifiers
      # (fingerprints + created_at only, never the full key).
      def verifiers
        render json: { verifiers: Recovery::Verifiers.list(user: current_user) }, status: :ok
      end

      # POST /v1/recovery/verifiers — register an Ed25519 verify key.
      # Step-up required; revokes all previous verifiers; rotates the
      # session token. Body: { public_key: (base64, 32 bytes decoded),
      # derivation: 'v1-hkdf-sha256' } — any other derivation is 422
      # unsupported_derivation (specs/recovery-protocol.md).
      def register_verifier
        require_step_up!
        verifier = Recovery::Verifiers.register(user: current_user, public_key: params[:public_key],
                                                derivation: params[:derivation])
        render json: { verifier: { id: verifier.id, fingerprint: verifier.fingerprint, derivation: verifier.derivation,
                                   created_at: verifier.created_at },
                       rotated_token: rotate_current_session! }, status: :created
      rescue Recovery::Verifiers::UnsupportedDerivation
        render json: { error: 'unsupported_derivation' }, status: :unprocessable_entity
      rescue Recovery::Verifiers::Error => e
        render json: { error: 'invalid_public_key', detail: e.message }, status: :unprocessable_entity
      end
    end
  end
end
