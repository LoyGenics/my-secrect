import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Multi-entry MV3 build. `public/` (manifest.json + icons) is copied to dist/ by Vite.
// Outputs (all relative to dist/, matching public/manifest.json):
//   popup/index.html, options/index.html, background.js, content.js
//
// NOTE on libsodium + MV3 service workers: libsodium-wrappers-sumo loads its
// WebAssembly module at runtime. If the worker cannot instantiate wasm under
// the extension CSP it falls back to the wrapper's embedded asm.js module
// (same API, same results, slower Argon2id). `assetsInclude` keeps any .wasm
// asset in the bundle if the bundler emits one. Verify on first load in
// Chrome (see README.md — Troubleshooting) that unlock works; if wasm fails
// there, unlock still works via the asm fallback, just slower.
export default defineConfig({
  plugins: [react()],
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
