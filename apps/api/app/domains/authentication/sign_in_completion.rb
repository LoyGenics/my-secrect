module Authentication
  # The common end of every sign-in that is not a passkey ceremony (email
  # code, Google, Apple): once the caller has proven who the user is and
  # settled the user row, check the device proof, then either hold the
  # sign-in for the second factor (MFA) or issue the session.
  #
  #   step = ActiveRecord::Base.transaction do
  #     ... spend the caller's ticket, find or create the user ...
  #     SignInCompletion.prove_device!(user:, challenge:, device:)
  #   end
  #   SignInCompletion.finish(user:, step:, method:, account_created:)
  #
  # prove_device! runs inside the caller's transaction, so a bad device
  # proof (DeviceProof::VerificationError) rolls back the ticket, the user
  # row and the device together. `challenge` is the server-issued,
  # single-use value the device signed (specs/device-identity.md §6.1).
  module SignInCompletion
    module_function

    # Returns { mfa_token: } when the user has MFA (the proven device is
    # held on that token) or { device: } (nil: unbound session).
    def prove_device!(user:, challenge:, device:)
      proof = DeviceProof.sign_in_proof!(user: user, challenge: challenge, proof: device)
      if user.mfa_enabled?
        { mfa_token: MfaTokens.issue(user: user, device: proof&.dig(:device), pending_device: proof&.dig(:enroll)) }
      else
        { device: DeviceProof.device_for!(user: user, proof: proof) }
      end
    end

    # After commit: the response body of every sign-in endpoint.
    def finish(user:, step:, method:, account_created:, user_agent: nil, ip_address: nil)
      return { mfa_required: true, mfa_token: step[:mfa_token], user_id: user.id } if step[:mfa_token]

      device = step[:device]
      token = SessionTokens.issue(user: user, device: device, user_agent: user_agent, ip_address: ip_address)
      Audit::Log.call(user: user, device: device, event_type: 'sign_in_succeeded', metadata: { method: method })
      { token: token, user_id: user.id, device_id: device&.id, expires_in: SessionTokens::TTL_SECONDS,
        account_created: account_created }
    end
  end
end
