import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { RECOVERY_KEY_FILENAME, recoveryKeyFileText } from './recoveryKeyText';

export { RECOVERY_KEY_FILENAME, recoveryKeyFileText };

/**
 * Hand the recovery key to the platform as a plain-text file: Android asks
 * for a folder (Storage Access Framework); iOS opens the share sheet, where
 * "Save to Files" is offered. The temporary iOS copy is deleted afterwards.
 * Returns false when the user cancels the folder picker.
 */
export async function saveRecoveryKeyFile(contents: string): Promise<boolean> {
  if (Platform.OS === 'android') {
    const storage = FileSystem.StorageAccessFramework;
    const access = await storage.requestDirectoryPermissionsAsync();
    if (!access.granted) return false;
    const uri = await storage.createFileAsync(access.directoryUri, RECOVERY_KEY_FILENAME.replace(/\.txt$/, ''), 'text/plain');
    await storage.writeAsStringAsync(uri, contents, { encoding: FileSystem.EncodingType.UTF8 });
    return true;
  }
  const cache = FileSystem.cacheDirectory;
  if (!cache || !await Sharing.isAvailableAsync()) throw new Error('Sharing unavailable');
  const uri = cache + RECOVERY_KEY_FILENAME;
  try {
    await FileSystem.writeAsStringAsync(uri, contents, { encoding: FileSystem.EncodingType.UTF8 });
    await Sharing.shareAsync(uri, { mimeType: 'text/plain', UTI: 'public.plain-text' });
    return true;
  } finally {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
  }
}
