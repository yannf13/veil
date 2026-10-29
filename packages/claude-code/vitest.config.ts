import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Tests use the engine's source, like the bundled hook does.
  resolve: { alias: { '@veil/engine': resolve(__dirname, '../engine/src/index.ts') } },
});
