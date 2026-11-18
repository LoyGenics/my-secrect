import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Web mirror of the desktop app (apps/desktop). The web App.tsx re-exports
// the desktop App, so Vite must be allowed to serve files outside apps/web:
// ../desktop/src (shared UI) and ../../packages (shared core types/crypto).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5174,
    proxy: { '/api': { target: process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3221', changeOrigin: true } },
    fs: {
      allow: ['..'],
    },
  },
});
