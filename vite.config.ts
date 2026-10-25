/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // React's act() refuses to run against a production build, so pin the test
    // env regardless of the NODE_ENV the shell happens to export.
    env: { NODE_ENV: 'test' },
  },
});
