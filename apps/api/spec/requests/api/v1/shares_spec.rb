require 'rails_helper'

# These domain files define Authentication::, Audit::, and Sharing::.
# app/domains/*/ is a Zeitwerk root per folder, so those nested constants
# are not autoloaded. Load the real files; do not stub them.
%w[
  app/domains/audit/log.rb
  app/domains/authentication/session_tokens.rb
  app/domains/authentication/step_up.rb
  app/domains/sharing/create.rb
  app/domains/sharing/revoke.rb
].each { |path| load Rails.root.join(path) }

RSpec.describe 'Shares API', type: :request do
  let(:owner) { create(:user) }
  let(:recipient) { create(:user) }
  let(:vault) { create(:vault, owner: owner) }
  let(:headers) { auth_headers_for(owner) }
  let(:opaque_key) { 'opaque-unverified-blob' }

  def post_share(user_headers: headers, vault_id: vault.id, email: recipient.email, encrypted_key: opaque_key)
    post '/api/v1/shares',
         params: { vault_id: vault_id, recipient_email: email, permission: 'read', encrypted_key: encrypted_key },
         headers: user_headers,
         as: :json
  end

  it 'lets the owner create a share and keeps the response status pending' do
    expect { post_share }.to change(Share, :count).by(1)
    expect(response).to have_http_status(:created)
    body = JSON.parse(response.body)
    expect(body.fetch('share').fetch('status')).to eq('pending')
    share = Share.find(body.fetch('share').fetch('id'))
    expect(share.status).to eq('pending')
    expect(share.owner_id).to eq(owner.id)
    expect(share.recipient_id).to eq(recipient.id)
    expect(share.vault_id).to eq(vault.id)
    expect(share.encrypted_key).to be_present
    expect(KeyEnvelope.where(vault_id: vault.id, recipient_id: recipient.id).count).to eq(1)
    expect(Share.where(status: 'active')).to be_empty
  end

  it 'rejects a blank encrypted_key with 422 JSON' do
    ['', '   ', nil].each do |encrypted_key|
      expect { post_share(encrypted_key: encrypted_key) }.not_to change(Share, :count)
      expect(response).to have_http_status(422)
      expect(response.media_type).to eq('application/json')
      body = JSON.parse(response.body)
      expect(body.fetch('error')).to eq('invalid_request')
      expect(body.fetch('message')).to include('encrypted_key')
    end
    expect(KeyEnvelope.count).to eq(0)
    expect(Share.where(status: 'active')).to be_empty
  end

  it 'does not let a non-owner create a share' do
    other = create(:user)
    expect { post_share(user_headers: auth_headers_for(other)) }.not_to change(Share, :count)
    expect(response).not_to have_http_status(:created)
    expect(response).to have_http_status(:not_found)
    expect(KeyEnvelope.where(vault_id: vault.id)).to be_empty
    expect(Share.where(vault_id: vault.id)).to be_empty
  end

  it 'lets the owner revoke a share and does not leave the share active' do
    post_share
    share_id = JSON.parse(response.body).fetch('share').fetch('id')
    expect(Share.find(share_id).status).to eq('pending')

    delete "/api/v1/shares/#{share_id}", headers: headers
    expect(response).to have_http_status(:no_content)
    share = Share.find(share_id)
    expect(share.status).to eq('revoked')
    expect(Share.where(id: share_id, status: 'active')).to be_empty
    expect(KeyEnvelope.where(vault_id: vault.id, recipient_id: recipient.id)).to be_empty
  end

  it 'rejects a self-share and an unknown recipient with 422 JSON' do
    expect { post_share(email: owner.email) }.not_to change(Share, :count)
    expect(response).to have_http_status(422)
    expect(JSON.parse(response.body).fetch('message')).to include('yourself')

    expect { post_share(email: 'missing-recipient@example.test') }.not_to change(Share, :count)
    expect(response).to have_http_status(422)
    expect(JSON.parse(response.body).fetch('message')).to include('recipient not found')
    expect(Share.where(status: 'active')).to be_empty
  end
end
