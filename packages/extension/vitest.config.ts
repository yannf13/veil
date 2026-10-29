import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Unit tests use the engine's source, like the bundled extension does.
    alias: { '@veil/engine': resolve(__dirname, '../engine/src/index.ts') },
  },
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
