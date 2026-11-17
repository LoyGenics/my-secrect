# CORS is deliberately narrow: only the Tauri desktop dev origin, the web
# client, and (in production) the exact deployed origins. Never '*'.
Rails.application.config.middleware.insert_before 0, Rack::Cors do
  allow do
    origins(*ENV.fetch('CORS_ORIGINS', 'http://localhost:1420,http://localhost:3000').split(','))
    resource '/api/*',
             headers: :any,
             methods: %i[get post put patch delete options head],
             expose: %w[Authorization],
             max_age: 600
    resource '/health', headers: :any, methods: %i[get]
  end
end
