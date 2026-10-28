// Bundles the hook into one dependency-free file. dist/ is committed: Claude Code installs
// plugins straight from git, with no build step.
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [resolve(here, 'src/hook.ts')],
  outfile: resolve(here, 'dist/veil-hook.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  legalComments: 'none',
  alias: { '@veil/engine': resolve(here, '../engine/src/index.ts') },
  banner: { js: '// Built from packages/claude-code/src/hook.ts by build.mjs. Do not edit.' },
  logLevel: 'warning',
});
console.log('Built dist/veil-hook.mjs');
