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
    # Accepted as audiences and they turn the provider on, but GET
    # /auth/providers does not list them: the desktop app ships its own
    # Google "Desktop app" client id (VITE_GOOGLE_DESKTOP_CLIENT_ID).
    UNLISTED_ENV_NAMES = { 'google' => { desktop_client_id: 'GOOGLE_DESKTOP_CLIENT_ID' } }.freeze

    module_function

    # { google: { web_client_id:, ... } | nil, apple: { services_id:, bundle_id: } | nil }
    def public_config
      ENV_NAMES.keys.to_h do |provider|
        [provider.to_sym, client_ids(provider)&.except(*UNLISTED_ENV_NAMES.fetch(provider, {}).keys)]
      end
    end

    # The accepted `aud` values of one provider ([] when it is off).
    def audiences(provider)
      client_ids(provider)&.values&.compact || []
    end

    # Every id of the provider, unlisted ones included (unset ones nil), or
    # nil when none is set.
    def client_ids(provider)
      names = ENV_NAMES.fetch(provider).merge(UNLISTED_ENV_NAMES.fetch(provider, {}))
      ids = names.transform_values { |name| ENV[name].presence }
      ids if ids.values.any?
    end
  end
end
