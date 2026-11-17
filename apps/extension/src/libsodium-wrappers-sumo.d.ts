// libsodium-wrappers-sumo@0.7 points `types` at a declaration that is not in
// the published tarball, and `moduleResolution: bundler` loads the ESM build
// which has no sibling .d.ts. This keeps the extension typecheck from failing
// on packages/crypto-adapters. It does not type the sodium API.
declare module 'libsodium-wrappers-sumo';
