# Sign-up email-ownership mail. Plain text only, rendered inline (no view
# templates). The code is passed in memory and written only into the
# message body: never stored, never logged (Action Mailer's logger is
# disabled in config/initializers/action_mailer.rb), never queued — callers
# use deliver_now so the code is not serialised into a job payload.
class AuthMailer < ApplicationMailer
  def verification_code(email:, code:, expires_in_minutes:)
    body = <<~TEXT
      Your my-secrect verification code is #{code}

      Enter it to finish creating your account. It expires in #{expires_in_minutes} minutes
      and works once.

      If you did not try to create a my-secrect account, ignore this email.
      Nobody can create an account with your address without this code.
    TEXT
    mail(to: email, subject: 'Your my-secrect verification code') do |format|
      format.text { render plain: body }
    end
  end

  # Sent instead of a code when the address already belongs to an account,
  # so the HTTP response stays identical (no account enumeration) while the
  # real owner learns what happened.
  def account_exists(email:)
    body = <<~TEXT
      Someone, maybe you, tried to create a my-secrect account with this email
      address. An account already exists for it, so no code was issued.

      To get in, sign in with your passkey. If this wasn't you, no action is needed.
    TEXT
    mail(to: email, subject: 'Sign-up attempt for your my-secrect account') do |format|
      format.text { render plain: body }
    end
  end
end
