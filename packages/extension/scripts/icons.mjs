// Renders src/icons/icon.svg to the PNG sizes Chrome wants. Run after changing the SVG: node scripts/icons.mjs
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
const svg = readFileSync(resolve(here, '../src/icons/icon.svg'), 'utf8');
const browser = await chromium.launch();
for (const size of [16, 32, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: resolve(here, `../src/icons/icon-${size}.png`), omitBackground: true });
  await page.close();
}
await browser.close();
console.log('Wrote icons');
