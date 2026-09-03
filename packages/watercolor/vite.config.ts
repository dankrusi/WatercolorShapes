import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'WatercolorShapes',
      formats: ['es', 'umd'],
      fileName: (fmt) => (fmt === 'es' ? 'watercolor-shapes.js' : 'watercolor-shapes.umd.cjs'),
    },
    sourcemap: true,
    target: 'es2022',
  },
});
