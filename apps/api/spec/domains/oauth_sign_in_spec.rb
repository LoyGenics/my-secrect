require 'rails_helper'

# Domain rules of Sign in with Google / Apple that the request spec does not
# reach: the JWKS cache, the ticket lifecycle and account deletion.
RSpec.describe 'Sign in with Google / Apple (domain)' do
  include ActiveSupport::Testing::TimeHelpers

  around { |example| with_env(OauthHelper::OAUTH_ENV) { example.run } }

  def verify(token, nonce)
    Authentication::IdToken.verify!(provider: 'google', id_token: token, nonce: nonce)
  end

  describe Authentication::IdToken do
    let(:nonce) { Authentication::OauthStart.call[:nonce] }

    it 'returns the subject and the normalised email' do
      stub_provider_jwks
      token = id_token_for('google', nonce: nonce, sub: 'g-1', email: ' Person@Example.TEST ')
      expect(verify(token, nonce)).to eq(subject: 'g-1', email: 'person@example.test', email_authoritative: false)
    end

    it 'fetches the JWKS once and serves later tokens from the cache' do
      stub_provider_jwks
      2.times { verify(id_token_for('google', nonce: nonce), nonce) }
      expect(jwks_fetches).to eq('google' => 1)
    end

    it 'refetches once for an unknown kid (key rotation), then at most once a minute' do
      rotated = jwks_for([provider_key, 'kid-main'], [provider_key('rotated'), 'kid-new'])
      sets = [jwks_for([provider_key, 'kid-main']), rotated]
      allow(described_class).to receive(:fetch_jwks) { sets.length > 1 ? sets.shift : sets.first }

      verify(id_token_for('google', nonce: nonce), nonce)
      travel(2.minutes) do
        expect(verify(id_token_for('google', nonce: nonce, key: provider_key('rotated'), kid: 'kid-new'), nonce))
          .to include(subject: 'subject-1')
        expect { verify(id_token_for('google', nonce: nonce, kid: 'kid-missing'), nonce) }
          .to raise_error(described_class::VerificationError)
      end
      expect(described_class).to have_received(:fetch_jwks).twice
    end

    it 'fails closed when the JWKS cannot be fetched, and backs off for 30 seconds' do
      allow(Net::HTTP).to receive(:start).and_raise(SocketError)
      token = id_token_for('google', nonce: nonce)
      2.times { expect { verify(token, nonce) }.to raise_error(described_class::VerificationError) }
      expect(Net::HTTP).to have_received(:start).once

      travel(31.seconds) do
        expect { verify(id_token_for('google', nonce: nonce), nonce) }.to raise_error(described_class::VerificationError)
      end
      expect(Net::HTTP).to have_received(:start).twice
    end

    it 'marks only Apple, gmail.com and matching-hd Google emails authoritative' do
      stub_provider_jwks
      authoritative = lambda do |provider, email, **claims|
        Authentication::IdToken.verify!(provider: provider, nonce: nonce,
                                        id_token: id_token_for(provider, nonce: nonce, email: email, **claims))[:email_authoritative]
      end
      expect(authoritative.call('apple', 'x@privaterelay.appleid.com')).to be(true)
      expect(authoritative.call('google', 'x@gmail.com')).to be(true)
      expect(authoritative.call('google', 'x@googlemail.com')).to be(true)
      expect(authoritative.call('google', 'x@corp.test', hd: 'corp.test')).to be(true)
      expect(authoritative.call('google', 'x@corp.test')).to be(false)
      expect(authoritative.call('google', 'x@corp.test', hd: 'other.test')).to be(false)
    end
  end

  describe Authentication::OauthStart do
    it 'derives the nonce from the ticket and spends the ticket once' do
      result = described_class.call
      expect(described_class.nonce_for(result[:ticket])).to eq(result[:nonce])

      record = described_class.live_ticket!(result[:ticket])
      described_class.consume!(record)
      expect { described_class.live_ticket!(result[:ticket]) }.to raise_error(described_class::VerificationError)
      expect { described_class.consume!(record) }.to raise_error(described_class::VerificationError)
    end

    it 'expires the ticket after 10 minutes' do
      ticket = described_class.call[:ticket]
      travel(10.minutes + 1.second) do
        expect { described_class.live_ticket!(ticket) }.to raise_error(described_class::VerificationError)
      end
    end
  end

  it 'deletes linked identities with the account' do
    user = User.create!(email: 'deleted@example.test')
    user.user_identities.create!(provider: 'apple', subject: 'a-gone', email: user.email)
    Accounts::Delete.call(user: user)
    expect(UserIdentity.where(subject: 'a-gone')).not_to exist
  end
end
