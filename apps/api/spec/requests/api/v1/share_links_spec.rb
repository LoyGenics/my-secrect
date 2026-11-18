require 'rails_helper'
RSpec.describe 'Expiring share links', type: :request do
  include ActiveSupport::Testing::TimeHelpers
  let(:owner) { create(:user) }
  let(:stranger) { create(:user) }
  let(:headers) { auth_headers_for(owner) }
  let(:payload) { SecureRandom.random_bytes(160) }
  let(:metadata) { SecureRandom.random_bytes(120) }
  def json = JSON.parse(response.body)
  def params_for_link
    { id: SecureRandom.urlsafe_base64(24), format_version: 1, expires_at: 1.day.from_now.iso8601(3), encrypted_payload: Base64.strict_encode64(payload), encrypted_owner_metadata: Base64.strict_encode64(metadata) }
  end
  def create_link
    values = params_for_link
    post '/api/v1/share-links', params: values, headers: headers, as: :json
    expect(response).to have_http_status(:created)
    values[:id]
  end
  it 'serves only ciphertext publicly and never returns owner metadata or a key' do
    id = create_link
    expect(ShareLink.find(id).encrypted_payload).to eq(payload)
    get "/api/v1/share-links/#{id}"
    expect(response).to have_http_status(:ok)
    expect(json.fetch('link').keys).to contain_exactly('id', 'format_version', 'expires_at', 'encrypted_payload')
    expect(response.headers['Cache-Control']).to include('no-store')
    get '/api/v1/share-links'
    expect(response).to have_http_status(:unauthorized)
  end
  it 'enforces ownership for list and revoke, erases ciphertext on revoke' do
    id = create_link
    get '/api/v1/share-links', headers: auth_headers_for(stranger)
    expect(json.fetch('links')).to eq([])
    delete "/api/v1/share-links/#{id}", headers: auth_headers_for(stranger)
    expect(response).to have_http_status(:not_found)
    delete "/api/v1/share-links/#{id}", headers: headers
    expect(response).to have_http_status(:no_content)
    expect(ShareLink.find(id).encrypted_payload).to be_nil
    expect(ShareLink.find(id).encrypted_owner_metadata).to be_nil
    get "/api/v1/share-links/#{id}"
    expect(response).to have_http_status(:not_found)
  end
  it 'refuses expired, unknown, oversized, malformed, and future-version links' do
    id = create_link
    travel 2.days do
      get "/api/v1/share-links/#{id}"
      expect(response).to have_http_status(:not_found)
    end
    [{ expires_at: 8.days.from_now.iso8601 }, { expires_at: 'not-a-date' }, { format_version: 2 }, { encrypted_payload: 'invalid base64' }, { encrypted_payload: Base64.strict_encode64('x' * 262_145) }].each do |overrides|
      post '/api/v1/share-links', params: params_for_link.merge(overrides), headers: headers, as: :json
      expect(response).to have_http_status(:unprocessable_entity)
    end
  end
end
