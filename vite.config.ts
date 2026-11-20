/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    benchmark: {
      include: ['test/**/*.bench.ts'],
    },
    testTimeout: 30000,
  },
});
