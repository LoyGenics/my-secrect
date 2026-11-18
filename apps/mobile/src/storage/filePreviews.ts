import * as FS from 'expo-file-system';
const PREFIX = 'my-secret-preview-';
export function previewPath(id: string, name: string): string {
  if (!/^[a-f0-9-]+$/i.test(id)) throw new Error('invalid preview path');
  const safe = name.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 180);
  if (!safe || safe === '.' || safe === '..') throw new Error('invalid preview name');
  return `${FS.cacheDirectory}${PREFIX}${id}/${safe}`;
}
export async function clearFilePreviews(): Promise<void> {
  if (!FS.cacheDirectory) return;
  const names = await FS.readDirectoryAsync(FS.cacheDirectory);
  await Promise.all(names.filter(name => name.startsWith(PREFIX)).map(name => FS.deleteAsync(`${FS.cacheDirectory}${name}`, { idempotent: true })));
}

export async function removeFilePreview(uri: string): Promise<void> {
  if (!FS.cacheDirectory || !uri.startsWith(`${FS.cacheDirectory}${PREFIX}`)) return;
  await FS.deleteAsync(uri.slice(0, uri.lastIndexOf('/')), { idempotent: true });
}
