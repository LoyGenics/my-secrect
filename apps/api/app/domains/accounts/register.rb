module Accounts
  # Account creation is email + passkey only (no passwords, ever).
  # The account is just an identity + device list; the vault key is
  # created on the CLIENT and never sent here in plaintext.
  module Register
    module_function
    def call(email:)
      user = User.find_or_create_by!(email: email.strip.downcase)
      Audit::Log.call(user: user, event_type: 'account_created') if user.previously_new_record?
      user
    end
  end
end
