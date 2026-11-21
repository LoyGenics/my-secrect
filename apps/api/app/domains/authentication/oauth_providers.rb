module Authentication
  # Which Sign in with Google / Apple client ids this deployment accepts,
  # read from ENV on every call. Client ids are public (they ship inside
  # every client); no provider secret is needed to verify an ID token.
  # A provider with no id set is off: GET /auth/providers answers null
  # for it, clients hide its button, and IdToken accepts none of its tokens.
  module OauthProviders
    ENV_NAMES = {
      'google' => { web_client_id: 'GOOGLE_WEB_CLIENT_ID', ios_client_id: 'GOOGLE_IOS_CLIENT_ID',
                    android_client_id: 'GOOGLE_ANDROID_CLIENT_ID', extension_client_id: 'GOOGLE_EXTENSION_CLIENT_ID' },
      'apple' => { services_id: 'APPLE_SERVICES_ID', bundle_id: 'APPLE_BUNDLE_ID' }
    }.freeze

    module_function

    # { google: { web_client_id:, ... } | nil, apple: { services_id:, bundle_id: } | nil }
    def public_config
      ENV_NAMES.keys.to_h { |provider| [provider.to_sym, client_ids(provider)] }
    end

    # The accepted `aud` values of one provider ([] when it is off).
    def audiences(provider)
      client_ids(provider)&.values&.compact || []
    end

    # Every id of the provider (unset ones nil), or nil when none is set.
    def client_ids(provider)
      ids = ENV_NAMES.fetch(provider).transform_values { |name| ENV[name].presence }
      ids if ids.values.any?
    end
  end
end
