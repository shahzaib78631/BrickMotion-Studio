import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

export default defineConfig({
  base: './',
  publicDir: path.join(repoRoot, 'public'),
  plugins: [react()],
  resolve: {
    alias: {
      '@web': path.join(repoRoot, 'src'),
    },
    dedupe: ['react', 'react-dom', 'three', 'zustand'],
  },
  server: {
    port: 5174,
    strictPort: true,
    fs: {
      allow: [repoRoot, here],
    },
  },
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true,
    copyPublicDir: false,
    target: 'es2022',
  },
});
