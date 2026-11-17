module AuthHelper
  # Issues a real Bearer token via SessionTokens (no passkey round-trip needed
  # for sync/item specs — passkey verification is covered separately).
  def auth_headers_for(user, device: nil)
    device ||= create(:device, user: user)
    token = Authentication::SessionTokens.issue(user: user, device: device)
    { 'Authorization' => "Bearer #{token}" }
  end
end
RSpec.configure { |c| c.include AuthHelper, type: :request }
