/**
 * `libsodium-wrappers-sumo` for the mobile app: metro.config.js resolves
 * that module name here for every importer except react-native-libsodium
 * itself, so packages/crypto-adapters, packages/sdk and the screens run on
 * native libsodium (JSI) instead of the broken asm.js fallback.
 */
import * as native from 'react-native-libsodium';
import { sha256 } from '@noble/hashes/sha256';
import { createSodium, type NativeSodium } from './libsodium-shim';

const sodium = createSodium(native as unknown as NativeSodium, sha256);
export default sodium;
