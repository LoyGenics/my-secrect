import {
  AiImportError, IMPORT_PREVIEW_MEDIA_TYPE, IMPORT_PREVIEW_PATH, normalizeAiPreview,
} from '../../../../packages/import-export/src/itemImport';
import { getValidToken, webTokenStore } from '../../../../packages/sdk/src/index';
import { isValidBase32Secret } from './totp';

/** The consent dialog is the only caller. Keep this separate from vault sync. */
export async function requestAiPreview(baseUrl: string, source: string, signal: AbortSignal) {
  const endpoint = new URL(baseUrl, window.location.href);
  const localHttp = endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !localHttp) || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
    throw new AiImportError(503);
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + IMPORT_PREVIEW_PATH;
  const token = await getValidToken(webTokenStore());
  if (!token) throw new AiImportError(401);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': IMPORT_PREVIEW_MEDIA_TYPE },
    body: JSON.stringify({ consent: true, source_text: source }),
    signal,
    cache: 'no-store',
    redirect: 'error',
  });
  if (!response.ok) throw new AiImportError(response.status);
  return normalizeAiPreview(await response.json(), source, isValidBase32Secret);
}
