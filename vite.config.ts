/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { assemblyCorrectorBridge } from './scripts/assembly-corrector-bridge';

export default defineConfig({
  plugins: [react(), assemblyCorrectorBridge()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // React's act() refuses to run against a production build, so pin the test
    // env regardless of the NODE_ENV the shell happens to export.
    env: { NODE_ENV: 'test' },
  },
});
