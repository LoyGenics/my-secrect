require 'securerandom'

module Recovery
  # Account-recovery challenge only. The server issues a single-use,
  # 5-minute challenge; the client answers with a proof (e.g. a signature
  # with the recovery key) that never reveals the vault key.
  # If the user lost every key + trusted device, there is NO recovery — by design.
  module Challenge
    class UnknownAccount < StandardError; end
    module_function
    def call(email:, kind: 'recovery_key')
      user = User.find_by(email: email.to_s.strip.downcase)
      raise UnknownAccount if user.nil?
      { challenge: SecureRandom.hex(32), kind: kind, expires_in: 300, user_id: user.id }
    end
  end
end
