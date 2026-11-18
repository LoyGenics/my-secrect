require 'rails_helper'

RSpec.describe 'Account billing', type: :request do
  let(:user) { create(:user) }
  let(:headers) { auth_headers_for(user) }
  let(:gateway) { instance_double(Billing::StripeGateway) }
  let(:account) { user.billing_accounts.create!(environment: 'test', customer_id: 'cus_fixture') }
  let(:catalog) { %w[monthly yearly lifetime].map { |option| { option: option, available: true, amount: 100, currency: 'usd' } } }
  let(:subscription) do
    { 'id' => 'sub_fixture', 'customer' => 'cus_fixture', 'livemode' => false, 'status' => 'active',
      'cancel_at_period_end' => false, 'items' => { 'data' => [{ 'price' => { 'id' => 'price_monthly' }, 'current_period_end' => 30.days.from_now.to_i }] } }
  end
  let(:session) do
    { 'id' => 'cs_fixture', 'customer' => 'cus_fixture', 'livemode' => false, 'status' => 'open',
      'expires_at' => 1.hour.from_now.to_i, 'url' => 'https://checkout.stripe.com/c/pay/cs_fixture',
      'payment_status' => 'unpaid', 'payment_intent' => 'pi_fixture' }
  end

  around do |example|
    values = { 'BILLING_ENVIRONMENT' => 'test', 'BILLING_WEB_URL' => 'http://localhost:5174',
      'STRIPE_API_KEY' => 'rk_test_fixture', 'STRIPE_WEBHOOK_SECRET' => 'webhook-spec-only',
      'STRIPE_PRICE_MONTHLY' => 'price_monthly', 'STRIPE_PRICE_YEARLY' => 'price_yearly', 'STRIPE_PRICE_LIFETIME' => 'price_lifetime',
      'REVENUECAT_SECRET_API_KEY' => nil, 'REVENUECAT_PRODUCTS' => nil }
    previous = values.keys.to_h { |key| [key, ENV[key]] }
    values.each { |key, value| value.nil? ? ENV.delete(key) : ENV[key] = value }
    example.run
  ensure
    previous.each { |key, value| value.nil? ? ENV.delete(key) : ENV[key] = value }
  end

  before do
    allow(Billing::StripeGateway).to receive(:new).and_return(gateway)
    allow(gateway).to receive(:catalog).and_return(catalog)
    allow(gateway).to receive(:subscriptions).and_return([])
    allow(gateway).to receive(:session).with('cs_fixture').and_return(session)
    allow(gateway).to receive(:customer).and_return('id' => 'cus_fixture')
    allow(gateway).to receive(:create_session).and_return(session)
    allow(gateway).to receive(:line_items).and_return([{ 'price' => { 'id' => 'price_lifetime' }, 'quantity' => 1 }])
    allow(gateway).to receive(:payment_intent).and_return('status' => 'succeeded', 'latest_charge' => {
      'id' => 'ch_fixture', 'customer' => 'cus_fixture', 'payment_intent' => 'pi_fixture', 'amount_refunded' => 0, 'disputed' => false })
  end

  def json = JSON.parse(response.body)
  def event(type:, object:, event_id: 'evt_fixture', live: false)
    { 'id' => event_id, 'object' => 'event', 'type' => type, 'livemode' => live,
      'data' => { 'object' => object } }
  end
  def deliver(value)
    body = value.to_json
    time = Time.now.to_i
    signature = OpenSSL::HMAC.hexdigest('SHA256', ENV.fetch('STRIPE_WEBHOOK_SECRET'), "#{time}.#{body}")
    post '/api/v1/billing/webhooks/stripe', params: body,
      headers: { 'Content-Type' => 'application/json', 'Stripe-Signature' => "t=#{time},v1=#{signature}" }
  end
  def purchase(provider: 'stripe', option: 'monthly', external_id: SecureRandom.uuid, status: 'active', expires_at: 30.days.from_now)
    user.billing_purchases.create!(provider: provider, environment: 'test', external_id: external_id,
      option: option, status: status, expires_at: expires_at, verified_at: Time.current)
  end

  it 'requires account authentication for every customer endpoint' do
    get '/api/v1/billing'
    expect(response).to have_http_status(:unauthorized)
    %w[checkout portal refresh].each do |action|
      post "/api/v1/billing/#{action}", params: { option: 'monthly' }, as: :json
      expect(response).to have_http_status(:unauthorized)
    end
  end

  it 'returns free access and server-owned prices without exposing provider secrets' do
    get '/api/v1/billing', headers: headers
    expect(response).to have_http_status(:ok)
    expect(json).to include('tier' => 'free', 'lifetime' => false, 'app_user_id' => user.id)
    expect(json['catalog'].size).to eq(3)
    expect(response.body).not_to include(ENV['STRIPE_API_KEY'], ENV['STRIPE_WEBHOOK_SECRET'])
    expect(response.headers['Cache-Control']).to include('no-store')
  end

  it 'shows unconfigured options honestly without contacting Stripe' do
    ENV.delete('STRIPE_API_KEY')
    expect(gateway).not_to receive(:catalog)
    get '/api/v1/billing', headers: headers
    expect(json['catalog'].map { |p| p['available'] }).to eq([false, false, false])
  end

  it 'ignores client price/customer/amount fields and selects subscription mode on the server' do
    post '/api/v1/billing/checkout', params: { option: 'monthly', price: 'price_attacker', customer: 'cus_other', amount: 1 }, headers: headers, as: :json
    expect(response).to have_http_status(:ok)
    expect(gateway).to have_received(:create_session).with(hash_including(mode: 'subscription', customer: 'cus_fixture',
      line_items: [{ price: 'price_monthly', quantity: 1 }], subscription_data: { billing_mode: { type: 'flexible' } }), kind_of(String))
    expect(BillingCheckout.count).to eq(1)
  end

  it 'uses one-time payment mode for Lifetime and reuses an open checkout' do
    2.times { post '/api/v1/billing/checkout', params: { option: 'lifetime' }, headers: headers, as: :json }
    expect(response).to have_http_status(:ok)
    expect(gateway).to have_received(:create_session).once.with(hash_including(mode: 'payment'), kind_of(String))
    expect(BillingCheckout.count).to eq(1)
  end

  it 'persists a pending checkout idempotency key after an ambiguous provider failure' do
    allow(gateway).to receive(:create_session).and_raise(Stripe::APIConnectionError.new('spec timeout'))
    post '/api/v1/billing/checkout', params: { option: 'yearly' }, headers: headers, as: :json
    expect(response).to have_http_status(:service_unavailable)
    checkout = BillingCheckout.sole
    allow(gateway).to receive(:create_session).and_return(session)
    post '/api/v1/billing/checkout', params: { option: 'yearly' }, headers: headers, as: :json
    expect(response).to have_http_status(:ok)
    expect(gateway).to have_received(:create_session).with(anything, checkout.id).twice
    expect(BillingCheckout.count).to eq(1)
  end

  it 'rejects arbitrary options and blocks duplicate purchases across providers' do
    post '/api/v1/billing/checkout', params: { option: 'free' }, headers: headers, as: :json
    expect(response).to have_http_status(:unprocessable_entity)
    purchase(provider: 'app_store')
    post '/api/v1/billing/checkout', params: { option: 'yearly' }, headers: headers, as: :json
    expect(response).to have_http_status(:conflict)
    expect(gateway).not_to have_received(:create_session)
  end

  it 'prevents another checkout while a past-due subscription can still charge' do
    purchase(status: 'past_due', expires_at: 1.day.ago)
    post '/api/v1/billing/checkout', params: { option: 'lifetime' }, headers: headers, as: :json
    expect(response).to have_http_status(:conflict)
  end

  it 'never creates portal sessions for a customer ID supplied by the browser' do
    account
    allow(gateway).to receive(:portal).with('cus_fixture').and_return('url' => 'https://billing.stripe.com/p/session/fixture')
    post '/api/v1/billing/portal', params: { customer: 'cus_victim' }, headers: headers, as: :json
    expect(response).to have_http_status(:ok)
    expect(gateway).to have_received(:portal).with('cus_fixture')
  end

  it 'rejects missing and invalid webhook signatures before invoking billing' do
    post '/api/v1/billing/webhooks/stripe', params: '{}', headers: { 'Content-Type' => 'application/json' }
    expect(response).to have_http_status(:bad_request)
    expect(BillingEvent.count).to eq(0)
  end

  it 'reconciles current state instead of trusting delayed event state, and deduplicates events' do
    account
    allow(gateway).to receive(:subscriptions).and_return([subscription.merge('status' => 'canceled')])
    value = event(type: 'customer.subscription.updated', object: subscription)
    2.times { deliver(value); expect(response).to have_http_status(:ok) }
    expect(BillingPurchase.sole.status).to eq('canceled')
    expect(BillingPurchase.sole.entitled?).to be(false)
    expect(BillingEvent.count).to eq(1)
    expect(gateway).to have_received(:subscriptions).once
  end

  it 'ignores live webhook events in the sandbox environment' do
    account
    deliver(event(type: 'customer.subscription.updated', object: subscription, live: true))
    expect(response).to have_http_status(:ok)
    expect(BillingPurchase.count).to eq(0)
  end

  it 'retains access after cancellation until the verified period expires' do
    account
    allow(gateway).to receive(:subscriptions).and_return([subscription.merge('cancel_at_period_end' => true)])
    deliver(event(type: 'customer.subscription.updated', object: subscription))
    grant = BillingPurchase.sole
    expect(grant.cancel_at_period_end).to be(true)
    expect(grant.entitled?).to be(true)
    expect(grant.entitled?(at: 31.days.from_now)).to be(false)
  end

  it 'keeps existing subscription renewals synchronized after the configured price is replaced' do
    account
    allow(gateway).to receive(:subscriptions).and_return([subscription])
    deliver(event(type: 'customer.subscription.created', object: subscription))
    ENV['STRIPE_PRICE_MONTHLY'] = 'price_new_monthly'
    subscription['cancel_at_period_end'] = true
    deliver(event(type: 'customer.subscription.updated', object: subscription, event_id: 'evt_retired_price'))
    expect(response).to have_http_status(:ok)
    expect(user.billing_purchases.sole).to have_attributes(price_id: 'price_monthly', cancel_at_period_end: true)
    expect(user.billing_purchases.sole.entitled?).to be(true)
  end

  it 'fulfills a Lifetime checkout against its original price after the public price changes' do
    account.billing_checkouts.create!(session_id: 'cs_fixture', option: 'lifetime', price_id: 'price_lifetime')
    ENV['STRIPE_PRICE_LIFETIME'] = 'price_new_lifetime'
    allow(gateway).to receive(:session).and_return(session.merge('status' => 'complete', 'payment_status' => 'paid'))
    deliver(event(type: 'checkout.session.completed', object: session))
    expect(response).to have_http_status(:ok)
    expect(user.billing_purchases.sole.entitled?).to be(true)
  end

  it 'does not grant Lifetime access for unpaid asynchronous checkout' do
    account.billing_checkouts.create!(session_id: 'cs_fixture', option: 'lifetime')
    allow(gateway).to receive(:session).and_return(session.merge('status' => 'complete'))
    deliver(event(type: 'checkout.session.completed', object: session))
    expect(BillingPurchase.count).to eq(0)
    allow(gateway).to receive(:session).and_return(session.merge('status' => 'complete', 'payment_status' => 'paid'))
    deliver(event(type: 'checkout.session.async_payment_succeeded', object: session, event_id: 'evt_paid'))
    expect(BillingPurchase.sole).to have_attributes(option: 'lifetime', expires_at: nil)
    expect(BillingPurchase.sole.entitled?).to be(true)
  end

  it 'does not allow account deletion while an asynchronous payment is processing' do
    account.billing_checkouts.create!(session_id: 'cs_fixture', option: 'lifetime', status: 'processing')
    allow(gateway).to receive(:session).and_return(session.merge('status' => 'complete'))
    allow(gateway).to receive(:payment_intent).and_return('status' => 'processing')
    expect { Accounts::Delete.call(user: user) }.to raise_error(Billing::DeletionGuard::ActiveBilling)
    expect(User.exists?(user.id)).to be(true)
  end

  it 'rejects subscription customer IDs belonging to another account' do
    account
    allow(gateway).to receive(:subscriptions).and_return([subscription.merge('customer' => 'cus_victim')])
    deliver(event(type: 'customer.subscription.created', object: subscription))
    expect(response).to have_http_status(:ok)
    expect(user.billing_purchases.count).to eq(0)
  end

  it 'resolves a disputed charge to its exact subscription through invoice payments' do
    account
    independent = purchase(provider: 'google_play', option: 'lifetime', expires_at: nil)
    allow(gateway).to receive(:subscriptions).and_return([subscription])
    allow(gateway).to receive(:charge).with('ch_dispute').and_return('id' => 'ch_dispute', 'customer' => account.customer_id, 'payment_intent' => 'pi_dispute')
    allow(gateway).to receive(:invoice_payments).with('pi_dispute').and_return([{ 'invoice' => 'in_fixture' }])
    allow(gateway).to receive(:invoice).with('in_fixture').and_return('customer' => account.customer_id,
      'parent' => { 'type' => 'subscription_details', 'subscription_details' => { 'subscription' => 'sub_fixture' } })
    deliver(event(type: 'charge.dispute.created', object: { 'charge' => 'ch_dispute' }))
    expect(response).to have_http_status(:ok)
    expect(user.billing_purchases.find_by!(external_id: 'sub_fixture').risk_state).to eq('disputed')
    expect(independent.reload.entitled?).to be(true)
  end

  it 'retries provider failures without acknowledging an event as processed' do
    account
    allow(gateway).to receive(:subscriptions).and_raise(Stripe::APIConnectionError.new('spec timeout'))
    deliver(event(type: 'invoice.paid', object: { 'customer' => account.customer_id }))
    expect(response).to have_http_status(:service_unavailable)
    expect(BillingEvent.count).to eq(0)
    allow(gateway).to receive(:subscriptions).and_return([subscription])
    deliver(event(type: 'invoice.paid', object: { 'customer' => account.customer_id }))
    expect(response).to have_http_status(:ok)
    expect(BillingPurchase.sole.entitled?).to be(true)
  end

  it 'revokes only the refunded Stripe purchase while independent store access survives' do
    account.billing_checkouts.create!(session_id: 'cs_fixture', option: 'lifetime', status: 'complete')
    store = purchase(provider: 'app_store', option: 'lifetime', expires_at: nil)
    allow(gateway).to receive(:session).and_return(session.merge('status' => 'complete', 'payment_status' => 'paid'))
    charge = { 'id' => 'ch_fixture', 'customer' => 'cus_fixture', 'payment_intent' => 'pi_fixture', 'amount_refunded' => 100 }
    allow(gateway).to receive(:charge).and_return(charge)
    allow(gateway).to receive(:invoice_payments).and_return([])
    deliver(event(type: 'charge.refunded', object: charge))
    expect(response).to have_http_status(:ok)
    expect(user.billing_purchases.find_by!(provider: 'stripe').entitled?).to be(false)
    expect(store.reload.entitled?).to be(true)
    expect(Billing::Access.summary(user: user)).to include(tier: 'pro', lifetime: true)
  end

  it 'does not remove ciphertext or the account when recurring billing is active' do
    purchase
    expect(Billing::DeletionGuard).to receive(:check!).and_call_original
    expect { Accounts::Delete.call(user: user) }.to raise_error(Billing::DeletionGuard::ActiveBilling)
    expect(User.exists?(user.id)).to be(true)
  end

  it 'does not orphan live recurring charges after a mistaken switch to test mode' do
    purchase.update!(environment: 'live')
    expect { Accounts::Delete.call(user: user) }.to raise_error(Billing::DeletionGuard::ActiveBilling)
    expect(User.exists?(user.id)).to be(true)
  end
end
