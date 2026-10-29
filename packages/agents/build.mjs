// Bundles the hooks into one dependency-free file. dist/ is committed: the Gemini CLI extension and
// the install script run it straight from a git checkout, with no build step.
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [resolve(here, 'src/main.ts')],
  outfile: resolve(here, 'dist/veil-agent.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  legalComments: 'none',
  alias: { '@veil/engine': resolve(here, '../engine/src/index.ts') },
  banner: { js: '// Built from packages/agents/src by build.mjs. Do not edit.' },
  logLevel: 'warning',
});
console.log('Built dist/veil-agent.mjs');
