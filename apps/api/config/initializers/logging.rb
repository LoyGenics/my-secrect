# Structured request log (production): one JSON line per request,
#   {"event":"request","method":"POST","path":"/api/v1/vaults","status":201,
#    "duration_ms":12.3,"request_id":"..."}
# and nothing else about the request: no parameters, headers, bodies, query
# strings or client IPs. This API carries bearer tokens, WebAuthn ceremonies,
# TOTP codes and ciphertext; none of them may reach a log line. Paths hold
# opaque ids only (no route takes a secret in the path).
#
# It replaces Rails::Rack::Logger (its "Started ..." line logs the client IP
# and the filtered query string) and the ActionController log subscriber
# ("Processing by ... Parameters: {...}" / "Completed ..."). Other log lines
# written while a request runs (e.g. a 5xx exception) are tagged with the
# request id so they can be joined to the request line.
module RequestLogging
  class Middleware
    def initialize(app)
      @app = app
    end

    def call(env)
      started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      request_id = env['action_dispatch.request_id']
      status = 500
      response = Rails.logger.tagged(request_id) { @app.call(env) }
      status = response[0].to_i
      response
    ensure
      Rails.logger.info(JSON.generate(
        event: 'request',
        method: env['REQUEST_METHOD'],
        path: "#{env['SCRIPT_NAME']}#{env['PATH_INFO']}",
        status: status,
        duration_ms: ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000).round(1),
        request_id: request_id
      ))
    end
  end
end

if Rails.env.production?
  Rails.application.config.middleware.swap Rails::Rack::Logger, RequestLogging::Middleware
  require 'action_controller/log_subscriber'
  ActionController::LogSubscriber.detach_from :action_controller
  # Worker: Sidekiq's own lines (start/done, job class, jid, elapsed) as JSON.
  # Job arguments are not part of Sidekiq's log context.
  Sidekiq.configure_server { |config| config.logger.formatter = Sidekiq::Logger::Formatters::JSON.new }
end
