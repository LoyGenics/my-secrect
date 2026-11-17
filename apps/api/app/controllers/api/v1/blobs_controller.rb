module Api
  module V1
    # Rails only AUTHORISES storage. The client uploads/downloads ciphertext
    # directly to S3/R2/MinIO via short-lived presigned URLs (5 min).
    class BlobsController < ApplicationController
      # Domain ArgumentError is a client error (missing manifest, bad parts,
      # quota, and so on). Mapped in this controller only, so other endpoints
      # keep their own status codes.
      rescue_from ArgumentError, with: :render_invalid_request

      # POST /v1/blobs/upload-session  (same blob_id again = resume)
      # body: { vault_id:, blob_id:, part_count:, part_size:, ciphertext_size:, encrypted_manifest: }
      def upload_session
        vault = current_user.vaults.find(params[:vault_id])
        session = Blobs::UploadSession.call(
          vault: vault,
          blob_id: params[:blob_id],
          part_count: params[:part_count].to_i,
          part_size: params[:part_size].to_i,
          ciphertext_size: params[:ciphertext_size].to_i,
          encrypted_manifest: params[:encrypted_manifest]
        )
        render json: session, status: session[:resumed] ? :ok : :created
      end

      # POST /v1/blobs/:id/complete
      # body: { parts: [{ part_number:, ciphertext_size:, ciphertext_sha256_b64: }] }
      def complete
        blob = Blobs::Access.writable(user: current_user, id: params[:id])
        Blobs::Complete.call(blob: blob, parts: params[:parts])
        render json: { blob: blob.as_json(only: %i[id status ciphertext_size]) }
      end

      # GET /v1/blobs/:id/download-session
      def download_session
        blob = Blobs::Access.readable(user: current_user, id: params[:id])
        render json: Blobs::DownloadSession.call(blob: blob)
      end

      private

      def render_invalid_request(error)
        render json: { error: 'invalid_request', message: error.message }, status: :unprocessable_entity
      end
    end
  end
end
