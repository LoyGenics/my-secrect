// Metro bundler config.
// 1. Monorepo: src/ imports ../../packages/core and
//    ../../packages/crypto-adapters, which live OUTSIDE apps/mobile.
//    Metro must watch the repo root and resolve node_modules from it,
//    otherwise those imports fail at bundle time.
// 2. (web / Node only — iOS and Android use 3.) libsodium-wrappers-sumo
//    ships a WASM build; Metro must be able
//    to resolve it. If `expo start` fails to load the WASM asset, check
//    the libsodium + Expo SDK version pairing in README.md.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
const repoRoot = path.resolve(__dirname, '../..');
config.watchFolders = [repoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(repoRoot, 'node_modules'),
];
config.resolver.assetExts.push('wasm');

// 3. Native libsodium. Hermes has no WebAssembly and libsodium-wrappers'
//    asm.js fallback is broken there (stale "random" bytes, AEAD that does
//    not round-trip). On iOS/Android every import of
//    'libsodium-wrappers-sumo' (packages/crypto-adapters, packages/sdk,
//    screens) resolves to the react-native-libsodium (JSI) shim instead.
const LIBSODIUM_RN = path.resolve(__dirname, 'src/crypto/libsodium-react-native.ts');
const NATIVE_PKG = `${path.sep}node_modules${path.sep}react-native-libsodium${path.sep}`;
const upstreamResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'libsodium-wrappers-sumo' && (platform === 'ios' || platform === 'android')
      && !context.originModulePath.includes(NATIVE_PKG)) {
    return { type: 'sourceFile', filePath: LIBSODIUM_RN };
  }
  return upstreamResolve
    ? upstreamResolve(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};
// dev/CryptoCheck.tsx loads whichever tests/crypto-vectors/*.json exist.
config.transformer.unstable_allowRequireContext = true;
module.exports = config;
