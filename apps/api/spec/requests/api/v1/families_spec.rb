require 'rails_helper'

RSpec.describe 'Family API', type: :request do
  let(:owner) { create(:user) }
  let(:member) { create(:user) }
  let(:outsider) { create(:user) }
  let(:owner_headers) { verified_headers(owner) }
  let(:member_headers) { verified_headers(member) }
  let(:outsider_headers) { verified_headers(outsider) }
  def json = JSON.parse(response.body)
  def verified_headers(user)
    headers = auth_headers_for(user)
    user.sessions.order(:created_at).last.update!(step_up_verified_at: Time.current)
    headers
  end
  def make_family
    post '/api/v1/family', headers: owner_headers
    expect(response).to have_http_status(:created), response.body
    Family.find(json.dig('family', 'id'))
  end
  def invite
    post '/api/v1/family/invitations', params: { email: member.email }, headers: owner_headers, as: :json
    expect(response).to have_http_status(:created), response.body
    FamilyMembership.find_by!(user: member)
  end
  def accept(invitation)
    post "/api/v1/family/invitations/#{invitation.id}/accept", headers: member_headers
    expect(response).to have_http_status(:ok), response.body
  end

  it 'requires authentication and step-up for all writes' do
    get '/api/v1/family'
    expect(response).to have_http_status(:unauthorized)
    post '/api/v1/family', headers: auth_headers_for(owner)
    expect(response).to have_http_status(:forbidden)
    expect(Family.count).to eq(0)
  end
  it 'creates six seats without granting access to the owner’s private vault' do
    vault = create(:vault, owner: owner)
    family = make_family
    expect(json.dig('family', 'seats')).to eq(6)
    expect(json.dig('family', 'role')).to eq('owner')
    expect(family.family_memberships.count).to eq(1)
    invitation = invite
    accept(invitation)
    get "/api/v1/vaults/#{vault.id}", headers: member_headers
    expect(response).to have_http_status(:not_found)
  end
  it 'shows pending invitees only their inviter and only accepts as the intended account' do
    make_family
    invitation = invite
    get '/api/v1/family', headers: member_headers
    expect(json['family']).to be_nil
    expect(json.dig('invitation', 'owner_email')).to eq(owner.email)
    expect(json.dig('invitation', 'members')).to be_nil
    post "/api/v1/family/invitations/#{invitation.id}/accept", headers: outsider_headers
    expect(response).to have_http_status(:not_found)
    accept(invitation)
    expect(json.dig('family', 'role')).to eq('member')
    expect(json.dig('family', 'members').map { |m| m['status'] }).to eq(%w[active active])
  end
  it 'reserves at most six seats including pending invitations' do
    family = make_family
    5.times do
      recipient = create(:user)
      post '/api/v1/family/invitations', params: { email: recipient.email }, headers: owner_headers, as: :json
      expect(response).to have_http_status(:created)
    end
    post '/api/v1/family/invitations', params: { email: member.email }, headers: owner_headers, as: :json
    expect(json['error']).to eq('family_full')
    expect(family.family_memberships.count).to eq(6)
  end
  it 'allows only one family or invitation per account' do
    make_family
    invite
    post '/api/v1/family', headers: member_headers
    expect(json['error']).to eq('already_in_family')
    post '/api/v1/family', headers: owner_headers
    expect(json['error']).to eq('already_in_family')
    expect(Family.count).to eq(1)
  end
  it 'expires invitations and releases the account for another family' do
    make_family
    invitation = invite
    invitation.update!(expires_at: 1.second.ago)
    post "/api/v1/family/invitations/#{invitation.id}/accept", headers: member_headers
    expect(json['error']).to eq('invitation_expired')
    get '/api/v1/family', headers: member_headers
    expect(json).to eq({ 'family' => nil, 'invitation' => nil, 'current_user_id' => member.id })
    post '/api/v1/family', headers: member_headers
    expect(response).to have_http_status(:created)
  end
  it 'forbids outsiders and ordinary members from managing others' do
    make_family
    invitation = invite
    accept(invitation)
    owner_membership = FamilyMembership.find_by!(user: owner)
    delete "/api/v1/family/members/#{invitation.id}", headers: outsider_headers
    expect(response).to have_http_status(:not_found)
    delete "/api/v1/family/members/#{owner_membership.id}", headers: member_headers
    expect(response).to have_http_status(:not_found)
    post '/api/v1/family/invitations', params: { email: outsider.email }, headers: member_headers, as: :json
    expect(response).to have_http_status(:not_found)
    delete '/api/v1/family', headers: member_headers
    expect(response).to have_http_status(:not_found)
  end
  it 'lets invitees decline and owners remove members without erasing private data' do
    make_family
    invitation = invite
    delete "/api/v1/family/members/#{invitation.id}", headers: member_headers
    expect(response).to have_http_status(:ok)
    expect(FamilyMembership.exists?(invitation.id)).to be(false)
    invitation = invite
    accept(invitation)
    vault = create(:vault, owner: member)
    delete "/api/v1/family/members/#{invitation.id}", headers: owner_headers
    expect(response).to have_http_status(:ok)
    expect(Vault.exists?(vault.id)).to be(true)
  end
  it 'prevents an owner leaving and allows dissolving without erasing any private vault' do
    make_family
    invitation = invite
    accept(invitation)
    vault = create(:vault, owner: member)
    membership = FamilyMembership.find_by!(user: owner)
    delete "/api/v1/family/members/#{membership.id}", headers: owner_headers
    expect(json['error']).to eq('owner_cannot_leave')
    delete '/api/v1/family', headers: owner_headers
    expect(response).to have_http_status(:ok)
    expect(FamilyMembership.count).to eq(0)
    expect(Family.count).to eq(0)
    expect(Vault.exists?(vault.id)).to be(true)
  end
  it 'cleans up the group when its owner deletes their account' do
    family = make_family
    invite
    owner.destroy!
    expect(Family.exists?(family.id)).to be(false)
    expect(FamilyMembership.count).to eq(0)
    expect(User.exists?(member.id)).to be(true)
  end
end
