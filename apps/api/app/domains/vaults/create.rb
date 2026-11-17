module Vaults
  module Create
    module_function
    def call(owner:, encrypted_metadata: nil, key_envelopes: [])
      Vault.transaction do
        vault = owner.vaults.create!(encrypted_metadata: encrypted_metadata, key_version: 1)
        Array(key_envelopes).each do |env|
          vault.key_envelopes.create!(recipient_id: env[:recipient_id] || env['recipient_id'], key_version: 1, encrypted_key: env[:encrypted_key] || env['encrypted_key'])
        end
        Audit::Log.call(user: owner, event_type: 'vault_created')
        vault
      end
    end
  end
end
