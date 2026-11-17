# Sign-up through the REAL code paths: the 6-digit code is read from the
# mail Action Mailer actually delivered (:test delivery in RSpec), never
# from the database (only its HMAC is stored) and never from the API (it
# never returns it). No step is stubbed.
module RegistrationHelper
  def delivered_mails_to(email)
    ActionMailer::Base.deliveries.select { |m| Array(m.to).include?(email) }
  end

  # The code from the newest mail sent to `email`, or nil when that mail
  # carries no code (e.g. the account-exists notice).
  def delivered_code_for(email)
    mail = delivered_mails_to(email).last
    raise "no mail was delivered to #{email}" unless mail
    mail.body.to_s[/verification code is (\d{6})/, 1]
  end

  # Domain-level: request + verify a code, return the registration ticket.
  def registration_ticket_for(email)
    Authentication::EmailOwnership.request_code(email: email)
    Authentication::EmailOwnership.verify_code(email: email, code: delivered_code_for(email))[:registration_ticket]
  end
end

# Request specs: the same steps through the HTTP routes.
module RegistrationRequestHelper
  def registration_ticket_via_api(email)
    post '/api/v1/auth/email/request', params: { email: email }, as: :json
    expect(response).to have_http_status(:accepted)
    post '/api/v1/auth/email/verify', params: { email: email, code: delivered_code_for(email) }, as: :json
    expect(response).to have_http_status(:ok)
    JSON.parse(response.body).fetch('registration_ticket')
  end

  # Email verification + POST /auth/passkeys/register. Returns the options body.
  def registration_options_via_api(email)
    ticket = registration_ticket_via_api(email)
    post '/api/v1/auth/passkeys/register', params: { email: email, registration_ticket: ticket }, as: :json
    expect(response).to have_http_status(:ok)
    JSON.parse(response.body)
  end
end

RSpec.configure do |c|
  c.include RegistrationHelper
  c.include RegistrationRequestHelper, type: :request
  c.before { ActionMailer::Base.deliveries.clear }
end
