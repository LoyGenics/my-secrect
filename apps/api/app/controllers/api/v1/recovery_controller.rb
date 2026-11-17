module Api
  module V1
    # Recovery challenges: account recovery only. The server can help a user
    # prove ownership of an ACCOUNT; it can never recover a lost vault key.
    # See specs/recovery-protocol.md — no backdoor, by design.
    class RecoveryController < ApplicationController
      skip_before_action :authenticate_request!, only: [:create_challenge]

      # POST /v1/recovery/challenges — body: { email:, kind: 'passphrase'|'trusted_device'|'recovery_key' }
      # Returns a single-use challenge (5 min). The client answers with a
      # proof that never reveals the vault key to the server.
      def create_challenge
        challenge = Recovery::Challenge.call(email: params[:email], kind: params[:kind] || 'recovery_key')
        render json: challenge, status: :created
      rescue Recovery::Challenge::UnknownAccount
        # Same response shape for unknown accounts: do not leak existence.
        render json: { challenge: nil, expires_in: 300 }, status: :created
      end
    end
  end
end
