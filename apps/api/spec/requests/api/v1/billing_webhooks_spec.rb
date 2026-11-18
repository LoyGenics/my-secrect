require 'rails_helper'

RSpec.describe 'Store billing webhooks', type: :request do
  let(:user) { create(:user) }
  let(:adapter) { instance_double(Billing::RevenueCat) }
  let(:event) { { id: 'rc_event_fixture', type: 'RENEWAL', environment: 'SANDBOX', app_user_id: user.id } }
  around do |example|
    values = { 'BILLING_ENVIRONMENT' => 'test', 'REVENUECAT_WEBHOOK_AUTHORIZATION' => 'Bearer store-spec' }
    old = values.keys.to_h { |key| [key, ENV[key]] }
    values.each { |key, value| ENV[key] = value }
    example.run
  ensure
    old.each { |key, value| value ? ENV[key] = value : ENV.delete(key) }
  end
  before do
    allow(Billing::RevenueCat).to receive(:ready?).and_return(true)
    allow(Billing::RevenueCat).to receive(:new).and_return(adapter)
    allow(adapter).to receive(:reconcile!)
  end
  def deliver(payload = event, authorization: 'Bearer store-spec')
    post '/api/v1/billing/webhooks/revenuecat', params: { event: payload }, headers: { 'Authorization' => authorization }, as: :json
  end

  it 'rejects missing or forged webhook authorization' do
    deliver(authorization: '')
    expect(response).to have_http_status(:unauthorized)
    expect(adapter).not_to have_received(:reconcile!)
  end

  it 'fetches current account state, ignores payload expiry and processes an event once' do
    2.times { deliver(event.merge(expiration_at_ms: 99_999_999_999_999)); expect(response).to have_http_status(:ok) }
    expect(adapter).to have_received(:reconcile!).with(user: user).once
    expect(BillingEvent.count).to eq(1)
    expect(BillingPurchase.count).to eq(0)
  end

  it 'does not apply production events to sandbox accounts' do
    deliver(event.merge(environment: 'PRODUCTION'))
    expect(response).to have_http_status(:ok)
    expect(adapter).not_to have_received(:reconcile!)
  end

  it 'retries a provider failure instead of acknowledging it' do
    allow(adapter).to receive(:reconcile!).and_raise(Billing::Config::Unavailable)
    deliver
    expect(response).to have_http_status(:service_unavailable)
    expect(BillingEvent.count).to eq(0)
  end

  it 'rejects transfers because the configured restore policy keeps original ownership' do
    deliver(event.merge(type: 'TRANSFER'))
    expect(response).to have_http_status(:conflict)
    expect(adapter).not_to have_received(:reconcile!)
  end
end
