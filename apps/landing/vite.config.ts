import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The site imports the shared clay illustrations from packages/ui, outside this
// app's root, so Vite may serve files two levels up.
export default defineConfig({
  plugins: [react()],
  server: { port: 5180, fs: { allow: ['../..'] } },
  build: { target: 'es2020', assetsInlineLimit: 0 },
});
