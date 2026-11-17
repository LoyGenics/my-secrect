import type { DeviceKeyApi } from '../../modules/device-key/src/DeviceKey.types';
import type { LegacyKeyValueStore } from './migration';
import type { VaultStore } from './vaultStore';

/**
 * What vault.ts needs from the device. nativePlatform.ts is the real one
 * (expo-sqlite + SQLCipher, AsyncStorage, DeviceKey); Node tests pass a
 * sql.js-backed store instead.
 */
export interface VaultPlatform {
  openStore(): Promise<VaultStore>;
  legacy: LegacyKeyValueStore;
  deviceKey: DeviceKeyApi;
}
