/** Native filesystem adapter for the existing authenticated chunk pipeline.
 * Only ciphertext chunks and a Vault-Key-encrypted manifest reach Documents.
 */
import * as FS from 'expo-file-system';
import { Buffer } from 'buffer';
import { downloadFile, loadBlobMetadata, uploadFile, type BlobApi, type FetchLike, type UploadSessionPart } from '../../../../packages/storage/src/upload';
import { libsodiumAdapter } from '../../../../packages/crypto-adapters/src/index';
import type { VaultItem } from '../../../../packages/core/src/types';
import { withVaultKey } from '../vault';
import { previewPath } from './filePreviews';
const ROOT = `${FS.documentDirectory}encrypted-files/`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MAX_FILE_BYTES = 128 * 1024 * 1024;
function folder(id: string): string { if (!UUID.test(id)) throw new Error('invalid blob id'); return `${ROOT}${id}/`; }
interface Session { blob_id: string; encrypted_manifest: string; parts: Array<{ part_number: number; ciphertext_size: number; url: string }> }
const urlFor = (id: string, part: number) => `https://local-vault.invalid/${id}/${part}`;
const api: BlobApi = {
  async createBlobUploadSession(_vault, input) {
    const dir = folder(input.blob_id); await FS.makeDirectoryAsync(dir, { intermediates: true });
    const parts: UploadSessionPart[] = Array.from({ length: input.part_count }, (_, index) => ({ part_number: index + 1, ciphertext_size: index < input.part_count - 1 ? input.part_size : input.ciphertext_size - input.part_size * (input.part_count - 1), url: urlFor(input.blob_id, index + 1) }));
    await FS.writeAsStringAsync(`${dir}session.json`, JSON.stringify({ blob_id: input.blob_id, encrypted_manifest: input.encrypted_manifest, parts }));
    return { blob_id: input.blob_id, parts };
  },
  async completeBlobUpload(id, parts) {
    const dir = folder(id); const session = JSON.parse(await FS.readAsStringAsync(`${dir}session.json`)) as Session;
    if (parts.length !== session.parts.length) throw new Error('incomplete file');
    for (const part of session.parts) {
      const info = await FS.getInfoAsync(`${dir}${part.part_number}.bin`);
      if (!info.exists || info.size !== part.ciphertext_size) throw new Error('incomplete file');
    }
    await FS.moveAsync({ from: `${dir}session.json`, to: `${dir}complete.json` });
    return { complete: true };
  },
  async createBlobDownloadSession(id) {
    const stored = JSON.parse(await FS.readAsStringAsync(`${folder(id)}complete.json`)) as Session;
    if (stored.blob_id !== id) throw new Error('invalid file');
    return { ...stored, parts: stored.parts.map(part => ({ ...part, url: urlFor(id, part.part_number) })) };
  },
};
const localFetch: FetchLike = async (url, init) => {
  const match = url.match(/^https:\/\/local-vault\.invalid\/([0-9a-f-]+)\/([1-9][0-9]*)$/);
  if (!match || Number(match[2]) > 5120) throw new Error('invalid local part');
  const path = `${folder(match[1])}${match[2]}.bin`;
  if (init?.method === 'PUT') {
    if (!(init.body instanceof Uint8Array)) throw new Error('invalid file bytes');
    await FS.writeAsStringAsync(path, Buffer.from(init.body).toString('base64'), { encoding: FS.EncodingType.Base64 });
    return new Response('', { status: 200 });
  }
  const bytes = Buffer.from(await FS.readAsStringAsync(path, { encoding: FS.EncodingType.Base64 }), 'base64');
  return new Response(bytes, { status: 200 });
};
export async function importNativeFile(asset: { uri: string; name: string; size: number; mimeType: string }, parentId: string, onProgress: (n: number) => void): Promise<VaultItem> {
  if (asset.size > MAX_FILE_BYTES || asset.size < 1) throw new Error('file_size');
  let blobId: string | undefined;
  try {
    const result = await withVaultKey(async (key, assertUnlocked) => {
      const result = await uploadFile({
        api: { ...api, createBlobUploadSession: async (vault, input) => {
          assertUnlocked();
          blobId = input.blob_id;
          return api.createBlobUploadSession(vault, input);
        } },
        vaultId: 'local', vaultKey: key, crypto: libsodiumAdapter,
        source: { size: asset.size, read: async (offset, end) => {
          assertUnlocked();
          return new Uint8Array(Buffer.from(await FS.readAsStringAsync(asset.uri, { encoding: FS.EncodingType.Base64, position: offset, length: end - offset }), 'base64'));
        } },
        fileName: asset.name, mimeType: asset.mimeType,
      }, { fetchImpl: localFetch, concurrency: 1, onProgress: (done, total) => onProgress(Math.round(done / Math.max(total, 1) * 100)) });
      assertUnlocked();
      return result;
    });
    const now = new Date().toISOString();
    return { id: result.blobId, type: /^(image|video|audio)\//.test(asset.mimeType) ? 'media' : 'document', schema_version: 1, title: asset.name,
      fields: { blob_id: result.blobId, mime_type: asset.mimeType, size_bytes: asset.size, parent_id: parentId, storage: 'local-encrypted-v1' }, tags: [], relations: [], attachments: [result.blobId], favorite: false, created_at: now, updated_at: now };
  } catch (e) { if (blobId) await removeEncryptedFile(blobId); throw e; }
}
export async function openNativeFile(item: VaultItem): Promise<{ uri: string; mime: string }> {
  const id = String(item.fields.blob_id ?? '');
  return withVaultKey(async (key, assertUnlocked) => {
    const { manifest } = await loadBlobMetadata(api, id, key, libsodiumAdapter);
    if (manifest.plaintext_size > MAX_FILE_BYTES) throw new Error('file_size');
    const result = await downloadFile(api, id, key, libsodiumAdapter, { fetchImpl: localFetch, concurrency: 1 });
    const unique = Array.from(libsodiumAdapter.randomBytes(8), value => value.toString(16).padStart(2, '0')).join('');
    const uri = previewPath(`${id}-${unique}`, item.title);
    const directory = uri.slice(0, uri.lastIndexOf('/'));
    try {
      assertUnlocked();
      await FS.makeDirectoryAsync(directory, { intermediates: true });
      await FS.writeAsStringAsync(uri, Buffer.from(result.bytes).toString('base64'), { encoding: FS.EncodingType.Base64 });
      assertUnlocked();
      return { uri, mime: String(item.fields.mime_type || 'application/octet-stream') };
    } catch (error) {
      await FS.deleteAsync(directory, { idempotent: true });
      throw error;
    } finally { result.bytes.fill(0); }
  });
}

export async function removeEncryptedFile(id: string): Promise<void> { if (UUID.test(id)) await FS.deleteAsync(folder(id), { idempotent: true }); }
export async function removeAllEncryptedFiles(): Promise<void> { await FS.deleteAsync(ROOT, { idempotent: true }); }
