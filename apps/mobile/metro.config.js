// Metro bundler config.
// 1. Monorepo: src/ imports ../../packages/core and
//    ../../packages/crypto-adapters, which live OUTSIDE apps/mobile.
//    Metro must watch the repo root and resolve node_modules from it,
//    otherwise those imports fail at bundle time.
// 2. libsodium-wrappers-sumo ships a WASM build; Metro must be able
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
module.exports = config;
