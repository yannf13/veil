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
import type { BrowserContext, Frame, Page } from 'playwright';
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

  // Serve the three sites from local files; leave everything else (Veil's own frame) alone.
  const hosts = new Set(SITES.map((s) => new URL(s.url).hostname));
  await context.route((url) => hosts.has(url.hostname), (route) => {
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

/** Everything the site's own scripts could read: all text and markup of the page. */
const pageContent = (page: Page) =>
  page.evaluate(() => document.documentElement.innerText + document.documentElement.outerHTML);

/** Veil's overlay frame (on the extension's origin). The test reads it through the browser's debugger. */
async function overlay(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((f) => f.url().includes('/overlay.html'))).toBe(true);
  return page.frames().find((f) => f.url().includes('/overlay.html'))!;
}

interface ChipBox {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const shownValues = (frame: Frame): Promise<ChipBox[]> =>
  frame.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('#chips > span')]
      .filter((s) => !s.hidden)
      .map((s) => {
        const r = s.getBoundingClientRect();
        return { text: s.textContent ?? '', x: r.x, y: r.y, w: r.width, h: r.height };
      }),
  );

/** Where a placeholder (with its padding) sits in the page, in viewport coordinates. */
const placeholderBox = (page: Page, placeholder: string, within: string) =>
  page.evaluate(
    ([ph, sel]) => {
      const root = document.querySelector(sel!)!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n as Text;
        const i = t.data.indexOf(ph!);
        if (i < 0) continue;
        let end = i + ph!.length;
        while (t.data[end] === ' ' || t.data[end] === ' ') end++;
        const range = document.createRange();
        range.setStart(t, i);
        range.setEnd(t, end);
        const r = range.getClientRects()[0]!;
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }
      return null;
    },
    [placeholder, within],
  );

for (const site of SITES) {
  describe(site.name, () => {
    it('masks on Enter, sends only placeholders, and shows real values only in its own frame', async () => {
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

      // The page keeps the placeholders; no real value is anywhere its scripts could read.
      await expect.poll(() => conversation(page)).toContain('You wrote: Email [EMAIL_1]');
      const content = await pageContent(page);
      for (const secret of [EMAIL, PHONE, KEY]) expect(content).not.toContain(secret);
      // The page can't look inside Veil's frame either.
      expect(await page.evaluate(() => document.querySelector('iframe')?.contentDocument ?? 'no access')).toBe('no access');

      // Veil's frame shows every value, in the user's message and in the answer.
      const frame = await overlay(page);
      await expect.poll(async () => (await shownValues(frame)).map((c) => c.text).sort()).toEqual(
        [EMAIL, EMAIL, KEY, KEY, PHONE, PHONE].sort(),
      );
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

describe('protected display', () => {
  async function conversationWithEmail(): Promise<{ page: Page; frame: Frame }> {
    const page = await open(SITES[0]);
    await page.keyboard.type(`Please write to ${EMAIL} today.`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await expect.poll(() => conversation(page)).toContain('You wrote:');
    const frame = await overlay(page);
    await expect.poll(async () => (await shownValues(frame)).length).toBe(2);
    return { page, frame };
  }

  /** The value drawn over the placeholder in the assistant's answer, if any. */
  async function answerChip(page: Page, frame: Frame) {
    const target = await placeholderBox(page, '[EMAIL_1]', '#messages .assistant');
    const chips = await shownValues(frame);
    const chip = chips.find((c) => target && Math.abs(c.x - target.x) < 1 && Math.abs(c.y - target.y) < 1);
    return { target, chip };
  }

  it('draws the value exactly over its placeholder, with room reserved for it', async () => {
    const { page, frame } = await conversationWithEmail();
    const { target, chip } = await answerChip(page, frame);
    expect(chip?.text).toBe(EMAIL);
    expect(Math.abs(chip!.w - target!.w)).toBeLessThan(1);
    expect(Math.abs(chip!.h - target!.h)).toBeLessThan(1);
    // The placeholder was padded to roughly the value's width, so the value isn't squeezed.
    const valueWidth = await page.evaluate((v) => {
      const c = document.createElement('canvas').getContext('2d')!;
      c.font = getComputedStyle(document.querySelector('#messages .assistant p')!).font;
      return c.measureText(v).width;
    }, EMAIL);
    expect(target!.w).toBeGreaterThanOrEqual(valueWidth);
    await page.close();
  });

  it('follows the text when the page scrolls', async () => {
    const { page, frame } = await conversationWithEmail();
    await page.evaluate(() => {
      document.body.style.paddingBottom = '2000px';
      window.scrollTo(0, 37);
    });
    await expect.poll(async () => {
      const { target, chip } = await answerChip(page, frame);
      return Boolean(target && chip && chip.text === EMAIL);
    }).toBe(true);
    await page.close();
  });

  it('hides values when something covers them, and shows them again after', async () => {
    const { page, frame } = await conversationWithEmail();
    await page.evaluate(() => {
      const cover = document.createElement('div');
      cover.id = 'cover';
      cover.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:10';
      document.body.append(cover);
    });
    await expect.poll(async () => (await shownValues(frame)).length).toBe(0);
    await page.evaluate(() => document.getElementById('cover')!.remove());
    await expect.poll(async () => (await shownValues(frame)).length).toBe(2);
    await page.close();
  });

  it('never pads or changes the message box', async () => {
    const { page } = await conversationWithEmail();
    await page.locator(SITES[0].composer).click();
    await page.keyboard.type('Reply to [EMAIL_1] please');
    await page.waitForTimeout(300);
    expect(await composerText(page)).toBe('Reply to [EMAIL_1] please');
    await page.close();
  });
});
