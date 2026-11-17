module Sharing
  # Every refusal the sharing protocol defines (specs/sharing-protocol.md §6).
  # Controllers render it as { error: code, message:, **details } with `status`.
  class Failure < StandardError
    attr_reader :status, :code, :details

    def initialize(status, code, message = code, details: {})
      @status = status
      @code = code
      @details = details
      super(message)
    end

    def self.invalid(message) = new(:unprocessable_entity, 'invalid_request', message)
    def self.forbidden(code) = new(:forbidden, code)
    def self.conflict(code, details: {}) = new(:conflict, code, details: details)
  end
end
