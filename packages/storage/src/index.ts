/** StorageProvider — one interface per DEPLOYMENT (not per user in v1).
 *  Per-user storage migration is deferred: backup / integrity / recovery get complex fast.
 *  Client uploads ciphertext directly via short-lived presigned URLs; Rails only authorises. */
export interface PresignedUpload { url: string; object_key: string; expires_at: string; }
export interface PresignedDownload { url: string; expires_at: string; }
export interface StorageProvider {
  readonly kind: 'local' | 's3' | 'r2' | 'minio';
  createUploadSession(blobId: string, partCount: number): Promise<PresignedUpload[]>;
  createDownloadSession(objectKey: string): Promise<PresignedDownload>;
  deleteObject(objectKey: string): Promise<void>;
}
// Implementations live in apps/api/app/domains/blobs/ (server-side authorisation)
// and in the clients (direct PUT/GET of ciphertext to the presigned URL).
// Chunked encrypted upload/download lives in ./upload.ts (implemented in
// code, not run against a live blob store — see that file's header).
export * from './upload';
