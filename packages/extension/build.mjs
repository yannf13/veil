// Bundles the extension into dist/, ready for chrome://extensions → "Load unpacked".
import { build } from 'esbuild';
import { cp, copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const common = {
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  platform: 'browser',
  legalComments: 'none',
  // Bundle the engine from source so the extension never depends on a stale engine build.
  alias: { '@veil/engine': resolve(here, '../engine/src/index.ts') },
  logLevel: 'warning',
};

await build({ ...common, entryPoints: [resolve(here, 'src/content.ts')], outfile: resolve(dist, 'content.js') });
await build({ ...common, entryPoints: [resolve(here, 'src/background.ts')], outfile: resolve(dist, 'background.js') });
await build({ ...common, entryPoints: [resolve(here, 'src/overlay.ts')], outfile: resolve(dist, 'overlay.js') });
await build({ ...common, entryPoints: [resolve(here, 'src/panel.ts')], outfile: resolve(dist, 'panel.js') });
await build({ ...common, entryPoints: [resolve(here, 'src/popup.ts')], outfile: resolve(dist, 'popup.js') });
await copyFile(resolve(here, 'manifest.json'), resolve(dist, 'manifest.json'));
await copyFile(resolve(here, 'src/overlay.html'), resolve(dist, 'overlay.html'));
await copyFile(resolve(here, 'src/panel.html'), resolve(dist, 'panel.html'));
await copyFile(resolve(here, 'src/popup.html'), resolve(dist, 'popup.html'));
await copyFile(resolve(here, 'managed_schema.json'), resolve(dist, 'managed_schema.json'));
await cp(resolve(here, 'src/icons'), resolve(dist, 'icons'), { recursive: true, filter: (f) => !f.endsWith('.svg') });

console.log(`Built extension in ${dist}`);
