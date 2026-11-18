import { Buffer } from 'buffer';
import * as Documents from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import { LOGIN_CSV_TEMPLATE } from '../../../../packages/import-export/src/index';
import {
  AiImportError, IMPORT_PREVIEW_MEDIA_TYPE, IMPORT_PREVIEW_PATH, IMPORT_TEMPLATE_FILENAME,
  MAX_CSV_BYTES, normalizeAiPreview,
} from '../../../../packages/import-export/src/itemImport';
import { isValidBase32Secret } from './totp';

interface ImportTransport {
  post(url: string, token: string, mediaType: string, body: string): Promise<{ status: number; body: string }>;
}

export async function requestAiPreview(
  baseUrl: string, source: string, getToken: () => Promise<string | null>, signal: AbortSignal,
) {
  const transport = requireOptionalNativeModule<ImportTransport>('ImportTransport');
  if (!transport) throw new AiImportError(503);
  const token = await getToken();
  if (!token) throw new AiImportError(401);
  if (signal.aborted) throw new Error('Import canceled');
  const url = baseUrl.trim().replace(/\/+$/, '') + IMPORT_PREVIEW_PATH;
  const response = await transport.post(url, token, IMPORT_PREVIEW_MEDIA_TYPE, JSON.stringify({ consent: true, source_text: source }));
  if (signal.aborted) throw new Error('Import canceled');
  if (response.status < 200 || response.status >= 300) throw new AiImportError(response.status);
  return normalizeAiPreview(JSON.parse(response.body), source, isValidBase32Secret);
}

export async function chooseImportCsv(signal: AbortSignal): Promise<{ text: string } | { tooLarge: true } | null> {
  const picked = await Documents.getDocumentAsync({ type: '*/*', multiple: false, copyToCacheDirectory: true });
  if (picked.canceled) return null;
  const [file] = picked.assets;
  // The document picker copied into the app cache. Never delete the user's
  // source document or read a URI if the copy did not land in the cache.
  const cache = FileSystem.cacheDirectory;
  if (!cache || !file.uri.startsWith(cache)) throw new Error('Import file copy unavailable');
  try {
    if (signal.aborted) return null;
    const info = await FileSystem.getInfoAsync(file.uri);
    if (!info.exists || info.isDirectory) throw new Error('Import file unavailable');
    if (info.size > MAX_CSV_BYTES) return { tooLarge: true };
    const bytes = Buffer.from(await FileSystem.readAsStringAsync(file.uri, { encoding: FileSystem.EncodingType.Base64 }), 'base64');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Invalid CSV encoding');
    return { text };
  } finally {
    await FileSystem.deleteAsync(file.uri, { idempotent: true }).catch(() => undefined);
  }
}

export async function saveCsvTemplate(): Promise<void> {
  if (Platform.OS === 'android') {
    const storage = FileSystem.StorageAccessFramework;
    const access = await storage.requestDirectoryPermissionsAsync();
    if (!access.granted) return;
    const filename = IMPORT_TEMPLATE_FILENAME.replace(/\.csv$/, '');
    const uri = await storage.createFileAsync(access.directoryUri, filename, 'text/csv');
    await storage.writeAsStringAsync(uri, LOGIN_CSV_TEMPLATE, { encoding: FileSystem.EncodingType.UTF8 });
    return;
  }
  const cache = FileSystem.cacheDirectory;
  if (!cache || !await Sharing.isAvailableAsync()) throw new Error('CSV sharing unavailable');
  const uri = cache + IMPORT_TEMPLATE_FILENAME;
  await FileSystem.writeAsStringAsync(uri, LOGIN_CSV_TEMPLATE, { encoding: FileSystem.EncodingType.UTF8 });
  await Sharing.shareAsync(uri, { mimeType: 'text/csv', UTI: 'public.comma-separated-values-text' });
}
