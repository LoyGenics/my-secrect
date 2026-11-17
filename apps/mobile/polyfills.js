// Hermes has no Web Crypto. libsodium-wrappers-sumo (when its module loads)
// and packages/crypto-adapters randomBytes() read
// globalThis.crypto.getRandomValues, so install the OS CSPRNG from
// expo-crypto before any crypto module is evaluated. index.js imports this
// file first; imports are hoisted, so it must be its own module.
import { getRandomValues } from 'expo-crypto';

if (typeof global.crypto !== 'object' || global.crypto === null) global.crypto = {};
if (typeof global.crypto.getRandomValues !== 'function') global.crypto.getRandomValues = getRandomValues;
