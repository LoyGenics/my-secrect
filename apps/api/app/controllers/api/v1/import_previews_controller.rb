module Api
  module V1
    class ImportPreviewsController < ApplicationController
      CONTENT_TYPE = 'application/vnd.my-secret.import+json'.freeze
      MAX_BODY_BYTES = Imports::OpenAiPreview::MAX_SOURCE_BYTES * 6 + 128

      def create
        response.headers['Cache-Control'] = 'no-store'
        return head :unsupported_media_type unless request.media_type == CONTENT_TYPE

        # Use a dedicated media type so Rails never logs a malformed JSON
        # body via its default parameter parser, even at debug level.
        raw = request.body.read(MAX_BODY_BYTES + 1).to_s
        return head :payload_too_large if raw.bytesize > MAX_BODY_BYTES

        body = JSON.parse(raw)
        return invalid_input unless body.is_a?(Hash)

        source_text = body['source_text']
        unless body['consent'] == true && source_text.is_a?(String) && source_text.valid_encoding? &&
               source_text.bytesize <= Imports::OpenAiPreview::MAX_SOURCE_BYTES && source_text.present?
          return invalid_input
        end

        render json: Imports::OpenAiPreview.call(source_text)
      rescue JSON::ParserError
        invalid_input
      rescue Imports::OpenAiPreview::Unavailable
        render json: { error: 'ai_import_unavailable' }, status: :service_unavailable
      rescue Imports::OpenAiPreview::Failed
        render json: { error: 'ai_import_failed' }, status: :bad_gateway
      end

      private

      def invalid_input
        render json: { error: 'invalid_import_input' }, status: :unprocessable_entity
      end
    end
  end
end
