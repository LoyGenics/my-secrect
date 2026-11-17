Rails.application.routes.draw do
  get '/health', to: ->(_env) { [200, { 'Content-Type' => 'application/json' }, ['{"ok":true}']] }

  namespace :api do
    namespace :v1 do
      # Account + device authentication (WebAuthn/passkeys). NOT vault unlock.
      post 'auth/passkeys/register', to: 'auth#register_passkey'
      post 'auth/passkeys/verify', to: 'auth#verify_passkey'
      post 'auth/passkeys/authenticate', to: 'auth#authenticate_passkey'
      get 'auth/passkeys', to: 'passkeys#index'
      post 'auth/passkeys/add/options', to: 'passkeys#add_options'
      post 'auth/passkeys/add/verify', to: 'passkeys#add_verify'
      delete 'auth/passkeys/:id', to: 'passkeys#destroy'
      post 'auth/mfa/verify', to: 'auth#verify_mfa'
      post 'auth/mfa/enroll', to: 'mfa#enroll'
      post 'auth/mfa/confirm', to: 'mfa#confirm'
      post 'auth/mfa/disable', to: 'mfa#disable'
      post 'auth/mfa/recovery_codes', to: 'mfa#regenerate_codes'
      post 'auth/step-up/totp', to: 'auth#step_up_totp'
      post 'auth/step-up/passkey/options', to: 'auth#step_up_passkey_options'
      post 'auth/step-up/passkey', to: 'auth#step_up_passkey'
      get 'auth/activity', to: 'auth#activity'
      get 'auth/sessions', to: 'sessions#index'
      delete 'auth/sessions/others', to: 'sessions#revoke_others'
      delete 'auth/sessions/:id', to: 'sessions#destroy'
      delete 'auth/account', to: 'accounts#destroy'
      resources :devices, only: %i[index create update destroy] do
        post :enroll, on: :collection
      end

      resources :vaults, only: %i[index create show] do
        get 'key-envelopes', to: 'vaults#key_envelopes'
        resources :items, only: %i[show update destroy]
        get 'sync', to: 'sync#pull'
        post 'sync/push', to: 'sync#push'
      end

      post 'blobs/upload-session', to: 'blobs#upload_session'
      post 'blobs/:id/complete', to: 'blobs#complete'
      get 'blobs/:id/download-session', to: 'blobs#download_session'

      # --- Sharing v1 (specs/sharing-protocol.md) -------------------------
      get 'identity-key', to: 'identity_keys#show'
      put 'identity-key', to: 'identity_keys#update'
      post 'identity-key/rotate', to: 'identity_keys#rotate'
      post 'identity-keys/lookup', to: 'identity_keys#lookup'
      resources :shares, only: %i[index create destroy] do
        member do
          get :record
          put :record, action: :write_record
          post :accept
        end
      end
      # --- end Sharing ------------------------------------------------------
      post 'recovery/challenges', to: 'recovery#create_challenge'
      post 'recovery/verify', to: 'recovery#verify'
      get 'recovery/verifiers', to: 'recovery#verifiers'
      post 'recovery/verifiers', to: 'recovery#register_verifier'

      # --- BEGIN auth: email ownership + device proof (Agent 02) ---------
      # Sign-up email verification before the first passkey registration
      # (Authentication::EmailOwnership).
      post 'auth/email/request', to: 'auth#request_email_code'
      post 'auth/email/verify', to: 'auth#verify_email_code'
      # Device proof-of-possession (specs/device-identity.md §6.2).
      post 'devices/challenges', to: 'devices#create_challenge'
      post 'devices/:id/bind', to: 'devices#bind'
      # Durable device revocation: re-approve a restricted passkey (§6.3).
      post 'auth/passkeys/:id/approve', to: 'passkeys#approve'
      # --- END auth: email ownership + device proof (Agent 02) -----------
    end
  end
end
