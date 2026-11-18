require 'rails_helper'

RSpec.describe Billing::RevenueCat do
  let(:user) { create(:user) }
  let(:adapter) { described_class.new }
  let(:subscription) { { 'store' => 'app_store', 'store_transaction_id' => 'store_tx_1', 'is_sandbox' => true,
    'expires_date' => 1.month.from_now.iso8601, 'unsubscribe_detected_at' => Time.current.iso8601 } }
  let(:snapshot) { { 'subscriptions' => { 'ios_monthly' => subscription }, 'non_subscriptions' => {} } }

  around do |example|
    config = { 'BILLING_ENVIRONMENT' => 'test', 'REVENUECAT_SECRET_API_KEY' => 'spec-only',
      'REVENUECAT_PRODUCTS' => { app_store: { ios_monthly: 'monthly', ios_lifetime: 'lifetime' }, google_play: { android_yearly: 'yearly' } }.to_json,
      'REVENUECAT_WEBHOOK_AUTHORIZATION' => 'Bearer spec-only' }
    old = config.keys.to_h { |key| [key, ENV[key]] }
    config.each { |key, value| ENV[key] = value }
    example.run
  ensure
    old.each { |key, value| value ? ENV[key] = value : ENV.delete(key) }
  end
  before { allow(adapter).to receive(:fetch_subscriber).with(user.id).and_return(snapshot) }
  def reconcile = user.with_lock { adapter.reconcile!(user: user) }

  it 'keeps store billing disabled until webhook authorization is configured' do
    ENV.delete('REVENUECAT_WEBHOOK_AUTHORIZATION')
    expect(described_class.ready?).to be(false)
  end

  it 'uses the verified snapshot and preserves access after renewal is disabled' do
    reconcile
    expect(user.billing_purchases.sole).to have_attributes(provider: 'app_store', option: 'monthly', cancel_at_period_end: true)
    expect(user.billing_purchases.sole.entitled?).to be(true)
  end

  it 'removes access to refunded or expired subscriptions' do
    subscription['refunded_at'] = Time.current.iso8601
    reconcile
    expect(user.billing_purchases.sole.entitled?).to be(false)
    subscription.delete('refunded_at')
    subscription['expires_date'] = 1.hour.ago.iso8601
    reconcile
    expect(user.billing_purchases.sole.entitled?).to be(false)
  end

  it 'accepts only the correct environment and configured native store products' do
    snapshot['subscriptions']['web_monthly'] = subscription.merge('store' => 'stripe')
    snapshot['subscriptions']['ios_unknown'] = subscription
    subscription['is_sandbox'] = false
    reconcile
    expect(user.billing_purchases.count).to eq(0)
  end

  it 'expires purchases removed from the snapshot while retaining independent Stripe access' do
    reconcile
    stripe = user.billing_purchases.create!(provider: 'stripe', environment: 'test', external_id: 'cs_independent',
      option: 'lifetime', status: 'active', verified_at: Time.current)
    snapshot['subscriptions'] = {}
    reconcile
    expect(user.billing_purchases.find_by!(provider: 'app_store').entitled?).to be(false)
    expect(stripe.reload.entitled?).to be(true)
  end

  it 'maps non-consumable Lifetime purchases without an expiry' do
    snapshot['non_subscriptions'] = { 'ios_lifetime' => [{ 'id' => 'rc_fixture', 'store' => 'app_store', 'is_sandbox' => true }] }
    snapshot['entitlements'] = { 'pro' => { 'product_identifier' => 'ios_lifetime', 'expires_date' => nil } }
    reconcile
    grant = user.billing_purchases.find_by!(option: 'lifetime')
    expect(grant.entitled?(at: 20.years.from_now)).to be(true)
    snapshot['entitlements'] = {}
    reconcile
    expect(grant.reload.entitled?).to be(false)
  end

  it 'rejects claiming another account’s verified transaction' do
    owner = create(:user)
    owner.billing_purchases.create!(provider: 'app_store', environment: 'test', external_id: 'subscription:store_tx_1',
      option: 'monthly', status: 'active', expires_at: 1.month.from_now, verified_at: Time.current)
    expect { reconcile }.to raise_error(Billing::Checkout::Conflict, 'purchase_owner_mismatch')
    expect(user.billing_purchases.count).to eq(0)
  end

  it 'keeps two independently verified store Lifetime purchases separate' do
    products = JSON.parse(ENV.fetch('REVENUECAT_PRODUCTS'))
    products['google_play']['android_lifetime'] = 'lifetime'
    ENV['REVENUECAT_PRODUCTS'] = products.to_json
    snapshot['non_subscriptions'] = {
      'ios_lifetime' => [{ 'id' => 'apple_fixture', 'store' => 'app_store', 'is_sandbox' => true }],
      'android_lifetime' => [{ 'id' => 'google_fixture', 'store' => 'play_store', 'is_sandbox' => true }]
    }
    snapshot['entitlements'] = {
      'pro_app_store_lifetime' => { 'product_identifier' => 'ios_lifetime', 'expires_date' => nil },
      'pro_google_play_lifetime' => { 'product_identifier' => 'android_lifetime', 'expires_date' => nil }
    }
    reconcile
    expect(user.billing_purchases.where(option: 'lifetime').count(&:entitled?)).to eq(2)
    snapshot['entitlements'].delete('pro_app_store_lifetime')
    reconcile
    expect(user.billing_purchases.find_by!(external_id: 'purchase:apple_fixture').entitled?).to be(false)
    expect(user.billing_purchases.find_by!(external_id: 'purchase:google_fixture').entitled?).to be(true)
  end

  it 'does not silently grant family-shared subscriptions as individually purchased access' do
    subscription['ownership_type'] = 'FAMILY_SHARED'
    reconcile
    expect(user.billing_purchases.count).to eq(0)
  end
end
