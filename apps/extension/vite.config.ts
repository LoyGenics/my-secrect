import { mkdir, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const require = createRequire(import.meta.url);
// Node's require condition is the CJS build. The 0.7.16 ESM build imports a
// missing "./libsodium-sumo.mjs" and uses top-level await for Node's url/path,
// which the es2020 MV3 bundle cannot emit. Same sumo library, CJS entry.
const libsodiumSumoCjs = require.resolve('libsodium-sumo');
const libsodiumWrappersCjs = require.resolve('libsodium-wrappers-sumo');

// Multi-entry MV3 build. `public/` (manifest.json + icons) is copied to dist/ by Vite.
// Outputs (all relative to dist/, matching public/manifest.json):
//   popup/index.html, options/index.html, background.js, content.js
//
// NOTE on libsodium + MV3 service workers: libsodium-wrappers-sumo loads its
// WebAssembly module at runtime, so the manifest CSP MUST contain
// 'wasm-unsafe-eval'. Without it wasm instantiation is blocked and libsodium
// silently falls back to its asm.js build, which in this bundle returned
// NON-RANDOM bytes (randombytes_buf leaked WASM heap contents, including the
// passphrase) and made unlock fail after vault creation. Found by the
// real-Chromium e2e (apps/extension/e2e); guarded by tests/manifest.test.ts.
// `assetsInclude` keeps any .wasm asset in the bundle if the bundler emits one.
export default defineConfig({
  plugins: [
    {
      name: 'libsodium-cjs-entry',
      enforce: 'pre',
      resolveId(source) {
        if (source === 'libsodium-wrappers-sumo') return libsodiumWrappersCjs;
        if (source === 'libsodium-sumo') return libsodiumSumoCjs;
        return null;
      },
    },
    {
      // Vite emits HTML at its source path (dist/src/popup/index.html).
      // The manifest loads popup/index.html and options/index.html.
      name: 'mv3-html-paths',
      async writeBundle() {
        const distUrl = new URL('./dist/', import.meta.url);
        await mkdir(new URL('popup/', distUrl), { recursive: true });
        await mkdir(new URL('options/', distUrl), { recursive: true });
        await rename(new URL('src/popup/index.html', distUrl), new URL('popup/index.html', distUrl));
        await rename(new URL('src/options/index.html', distUrl), new URL('options/index.html', distUrl));
        await rm(new URL('src/', distUrl), { recursive: true, force: true });
      },
    },
    react(),
  ],
  assetsInclude: ['**/*.wasm'],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: fileURLToPath(new URL('./src/popup/index.html', import.meta.url)),
        options: fileURLToPath(new URL('./src/options/index.html', import.meta.url)),
        background: fileURLToPath(new URL('./src/background.ts', import.meta.url)),
        content: fileURLToPath(new URL('./src/content/content.ts', import.meta.url)),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
});
