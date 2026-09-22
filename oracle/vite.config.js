import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// The bundle is engine chrome: build.js copies src/oracle/ to /__oracle/ like /__canvas/.
const out = process.env.ORACLE_OUT || path.resolve(here, '../src/oracle');

export default defineConfig({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: out,
    emptyOutDir: false,
    cssCodeSplit: false,
    sourcemap: false,
    lib: {
      entry: path.resolve(here, 'src/main.jsx'),
      name: 'Oracle',
      formats: ['iife'],
      fileName: () => 'oracle.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: (a) => (a.name && a.name.endsWith('.css') ? 'oracle.css' : '[name][extname]'),
      },
    },
  },
});
