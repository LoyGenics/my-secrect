require 'rails_helper'

RSpec.describe 'Vaults API', type: :request do
  let(:user) { create(:user) }
  let(:headers) { auth_headers_for(user) }
  let(:key_check) { Base64.strict_encode64("#{'n' * 24}vault-key-check-ciphertext") }

  def body = JSON.parse(response.body)

  it 'returns the encrypted metadata (the Vault Key check) exactly as the client sent it' do
    post '/api/v1/vaults', params: { encrypted_metadata: key_check }, headers: headers, as: :json
    expect(response).to have_http_status(:created)
    id = body['vault']['id']
    expect(body['vault']['encrypted_metadata']).to eq(key_check)

    get '/api/v1/vaults', headers: headers
    expect(body['vaults'].map { |v| v.slice('id', 'encrypted_metadata') }).to eq([{ 'id' => id, 'encrypted_metadata' => key_check }])
    get "/api/v1/vaults/#{id}", headers: headers
    expect(body['vault']['encrypted_metadata']).to eq(key_check)
  end

  it 'returns null for a vault without metadata or with metadata that is not base64 text' do
    create(:vault, owner: user, encrypted_metadata: nil)
    create(:vault, owner: user, encrypted_metadata: "\xFF\x00raw".b)
    get '/api/v1/vaults', headers: headers
    expect(body['vaults'].map { |v| v['encrypted_metadata'] }).to eq([nil, nil])
  end

  it "never lists another user's vaults" do
    create(:vault, encrypted_metadata: key_check)
    get '/api/v1/vaults', headers: headers
    expect(body['vaults']).to eq([])
  end
end
