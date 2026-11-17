module Api
  module V1
    # Rails only AUTHORISES storage. The client uploads/downloads ciphertext
    # directly to S3/R2/MinIO via short-lived presigned URLs (5 min).
    class BlobsController < ApplicationController
      # POST /v1/blobs/upload-session — body: { vault_id:, blob_id:, part_count:, ciphertext_size: }
      def upload_session
        vault = current_user.vaults.find(params[:vault_id])
        session = Blobs::UploadSession.call(vault: vault, blob_id: params[:blob_id], part_count: params[:part_count].to_i, ciphertext_size: params[:ciphertext_size].to_i)
        render json: session, status: :created
      end

      # POST /v1/blobs/:id/complete — marks upload done after the client
      # confirms all parts uploaded; server only checks sizes/counts.
      def complete
        blob = current_user.blobs.find(params[:id])
        Blobs::Complete.call(blob: blob)
        render json: { blob: blob.as_json(only: %i[id status ciphertext_size]) }
      end

      # GET /v1/blobs/:id/download-session
      def download_session
        blob = current_user.blobs.find(params[:id])
        render json: Blobs::DownloadSession.call(blob: blob)
      end
    end
  end
end
