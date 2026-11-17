require 'rails_helper'

RSpec.describe User, type: :model do
  it 'normalises and validates email' do
    u = User.create(email: '  Alice@Example.Test ')
    expect(u.email).to eq('alice@example.test')
    expect(User.new(email: 'not-an-email')).not_to be_valid
    expect(User.new(email: 'alice@example.test')).not_to be_valid
  end
end
