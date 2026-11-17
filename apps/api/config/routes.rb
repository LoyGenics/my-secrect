Rails.application.routes.draw do
  get '/health', to: ->(_env) { [200, { 'Content-Type' => 'application/json' }, ['{"ok":true}']] }

  namespace :api do
    namespace :v1 do
      # Account + device authentication (WebAuthn/passkeys). NOT vault unlock.
      post 'auth/passkeys/register', to: 'auth#register_passkey'
      post 'auth/passkeys/verify', to: 'auth#verify_passkey'
      resources :devices, only: %i[index create destroy] do
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

      resources :shares, only: %i[create destroy]
      post 'recovery/challenges', to: 'recovery#create_challenge'
    end
  end
end
