import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      // Point at the library source rather than its build output, so the demo
      // hot-reloads on library edits and never renders against a stale dist.
      '@watercolor/shapes': fileURLToPath(new URL('../../packages/watercolor/src/index.ts', import.meta.url)),
    },
  },
  worker: { format: 'es' },
  build: { target: 'es2022', outDir: 'dist' },
});
