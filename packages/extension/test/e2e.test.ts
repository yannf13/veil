/**
 * Loads the built extension into a real Chromium and drives stand-in chat pages served at
 * the real site addresses (chatgpt.com, claude.ai, gemini.google.com) from local files,
 * so Chrome injects the content script exactly as it would on the live sites. No network.
 */
import { buildSync } from 'esbuild';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(here, '../dist');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
}

const SITES = [
  { name: 'ChatGPT', kind: 'chatgpt', url: 'https://chatgpt.com/', composer: '#prompt-textarea', send: '[data-testid="send-button"]' },
  { name: 'ChatGPT textarea layout (live, Oct 2026)', kind: 'chatgpt-textarea', url: 'https://chatgpt.com/?layout=textarea', composer: 'form textarea', send: 'button[type="submit"]' },
  { name: 'Claude', kind: 'claude', url: 'https://claude.ai/new', composer: 'fieldset .ProseMirror', send: 'button[aria-label="Send message"]' },
  { name: 'Gemini', kind: 'gemini', url: 'https://gemini.google.com/app', composer: 'rich-textarea .ql-editor', send: 'button.send-button' },
] as const;

// Fake, format-valid key assembled at runtime so secret scanners stay quiet.
const KEY = 'sk-proj-' + 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU1vW0xYz'.repeat(2);
const EMAIL = 'jane.doe@example.org';
const PHONE = '+33 6 12 34 56 78';

let context: BrowserContext;
let appScript: string;

beforeAll(async () => {
  appScript = buildSync({
    entryPoints: [resolve(here, 'fixtures/chat-app.ts')],
    bundle: true,
    format: 'iife',
    write: false,
    target: 'chrome120',
    logLevel: 'error',
  }).outputFiles[0]!.text;

  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'veil-e2e-')), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  if (context.serviceWorkers().length === 0) await context.waitForEvent('serviceworker');

  await context.route('**/*', (route) => {
    const site = SITES.find((s) => s.url === route.request().url());
    if (!site || route.request().resourceType() !== 'document') return route.abort();
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html data-kind="${site.kind}"><head><meta charset="utf-8"><title>${site.name}</title></head><body><script>${appScript}</script></body></html>`,
    });
  });
});

afterAll(async () => {
  await context?.close();
});

async function open(site: (typeof SITES)[number]): Promise<Page> {
  const page = await context.newPage();
  await page.goto(site.url);
  await page.locator(site.composer).click();
  // Give the content script a moment to load its vault.
  await page.waitForTimeout(150);
  return page;
}

const sent = (page: Page) => page.evaluate(() => window.__fixture.sent);
const composerText = (page: Page) => page.evaluate(() => window.__fixture.getText());
const conversation = (page: Page) => page.locator('#messages').innerText();

for (const site of SITES) {
  describe(site.name, () => {
    it('masks on Enter, sends only placeholders, and shows the real values back', async () => {
      const page = await open(site);
      await page.keyboard.type(`Email ${EMAIL} or call ${PHONE}.`);
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type(`Key: ${KEY}`);

      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      expect(await sent(page)).toEqual([]); // first Enter only masks
      const masked = await composerText(page);
      expect(masked).toContain('[EMAIL_1]');
      expect(masked).toContain('[PHONE_1]');
      expect(masked).toContain('[API_KEY_1]');
      for (const secret of [EMAIL, PHONE, KEY]) expect(masked).not.toContain(secret);
      expect(masked).toMatch(/\.\n+Key: /); // the line break survived

      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      const [message] = await sent(page);
      expect(message).toBeDefined();
      for (const secret of [EMAIL, PHONE, KEY]) expect(message).not.toContain(secret);
      expect(message).toContain('[EMAIL_1]');

      await expect.poll(() => conversation(page)).toContain(`You wrote: Email ${EMAIL}`);
      const shown = await conversation(page);
      expect(shown).toContain(KEY);
      expect(shown).not.toContain('[EMAIL_1]');
      await page.close();
    });

    it('masks when the send button is clicked', async () => {
      const page = await open(site);
      await page.keyboard.type(`IBAN DE89 3704 0044 0532 0130 00 please`);
      await page.locator(site.send).click();
      await page.waitForTimeout(300);
      expect(await sent(page)).toEqual([]);
      expect(await composerText(page)).toContain('IBAN [IBAN_');

      await page.locator(site.send).click();
      await page.waitForTimeout(300);
      const [message] = await sent(page);
      expect(message).toMatch(/^IBAN \[IBAN_\d+\] please$/);
      await page.close();
    });

    it('lets ordinary messages through on the first Enter', async () => {
      const page = await open(site);
      await page.keyboard.type('What is the capital of Saarland?');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      expect(await sent(page)).toEqual(['What is the capital of Saarland?']);
      await page.close();
    });
  });
}

describe('across tabs', () => {
  it('keeps one placeholder per value on a site, and restores in other tabs', async () => {
    const site = SITES[0];
    const first = await open(site);
    await first.keyboard.type(`Write to ${EMAIL}`);
    await first.keyboard.press('Enter');
    await first.waitForTimeout(300);
    const placeholder = /\[EMAIL_\d+\]/.exec(await composerText(first))?.[0];
    expect(placeholder).toBeDefined();

    const second = await open(site);
    await second.keyboard.type(`Again: ${EMAIL} and other@example.org`);
    await second.keyboard.press('Enter');
    await second.waitForTimeout(300);
    const text = await composerText(second);
    expect(text).toContain(`Again: ${placeholder}`);
    expect(text).not.toContain(`and ${placeholder}`);
    await first.close();
    await second.close();
  });
});
