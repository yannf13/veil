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

/** Pages that aren't one of the sites above but are served on their addresses. */
const REDESIGN = { name: 'Claude after a redesign', kind: 'redesign', url: 'https://claude.ai/redesign', composer: '.input-v2', send: 'button[aria-label="Submit"]' } as const;
const PAGES = [...SITES, REDESIGN];

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
  const hosts = new Set(PAGES.map((s) => new URL(s.url).hostname));
  await context.route((url) => hosts.has(url.hostname), (route) => {
    const site = PAGES.find((s) => s.url === route.request().url());
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

async function open(site: (typeof PAGES)[number]): Promise<Page> {
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

describe('Veil window', () => {
  async function veilWindow(page: Page): Promise<Frame> {
    await expect.poll(() => page.frames().some((f) => f.url().includes('/panel.html'))).toBe(true);
    return page.frames().find((f) => f.url().includes('/panel.html'))!;
  }
  const rows = (frame: Frame) =>
    frame.evaluate(() =>
      [...document.querySelectorAll('li')].map((li) => [
        li.querySelector('code')?.textContent ?? '',
        li.querySelector('.value')?.textContent ?? '',
      ]),
    );
  /** Height of the Veil window as the user sees it: 0 while it is hidden (transparent and click-through). */
  const windowHeight = (page: Page) =>
    page.evaluate(() => {
      const f = document.querySelector<HTMLIFrameElement>('iframe[title="Veil"]');
      return !f || getComputedStyle(f).opacity === '0' ? 0 : f.getBoundingClientRect().height;
    });

  it('lists the hidden values as soon as the message is masked, before sending', async () => {
    const page = await open(SITES[0]);
    await page.keyboard.type(`Mail ${EMAIL}, call ${PHONE}`);
    await page.keyboard.press('Enter');
    const frame = await veilWindow(page);
    await expect.poll(() => rows(frame)).toEqual([
      ['[EMAIL_1]', EMAIL],
      ['[PHONE_1]', PHONE],
    ]);
    await expect.poll(() => windowHeight(page)).toBeGreaterThan(40);
    // The page can't read the window.
    expect(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('iframe[title="Veil"]')?.contentDocument ?? 'no access')).toBe('no access');
    expect(await pageContent(page)).not.toContain(EMAIL);
    await page.close();
  });

  it('copies a value to the clipboard', async () => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://chatgpt.com' });
    const page = await open(SITES[0]);
    await page.keyboard.type(`Key: ${KEY}`);
    await page.keyboard.press('Enter');
    const frame = await veilWindow(page);
    await expect.poll(() => rows(frame)).toEqual([['[API_KEY_1]', KEY]]);
    const copy = frame.locator('li button').first(); // by position: its label changes to "Copied"
    await copy.click();
    await expect.poll(() => copy.textContent()).toBe('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(KEY);
    await page.close();
  });

  it('minimizes to a small pill and opens again', async () => {
    const page = await open(SITES[0]);
    await page.keyboard.type(`Mail ${EMAIL}`);
    await page.keyboard.press('Enter');
    const frame = await veilWindow(page);
    await expect.poll(() => windowHeight(page)).toBeGreaterThan(40);
    await frame.getByRole('button', { name: 'Hide' }).click();
    await expect.poll(() => frame.getByRole('button', { name: /Veil · 1 hidden value/ }).isVisible()).toBe(true);
    await expect.poll(() => windowHeight(page)).toBeLessThan(45);
    await frame.getByRole('button', { name: /Veil · 1 hidden value/ }).click();
    await expect.poll(() => rows(frame)).toEqual([['[EMAIL_1]', EMAIL]]);
    await page.close();
  });

  it('never covers the message box or its send button', async () => {
    const page = await open(SITES[0]);
    // Like ChatGPT: the message box pinned to the bottom, in a short window, right where the Veil window would go.
    await page.setViewportSize({ width: 900, height: 260 });
    await page.addStyleTag({ content: 'form { position: fixed; left: 0; right: 0; bottom: 0; height: 120px; background: #eee; }' });
    await page.keyboard.type(`Mail ${EMAIL}`);
    await page.keyboard.press('Enter');
    await expect.poll(() => windowHeight(page)).toBeGreaterThan(40);
    await page.waitForTimeout(600); // the window re-places itself every 500 ms
    const overlap = await page.evaluate(() => {
      const a = document.querySelector('iframe[title="Veil"]')!.getBoundingClientRect();
      const b = document.querySelector('form')!.getBoundingClientRect();
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    });
    expect(overlap).toBe(false);
    await page.close();
  });

  it('stays out of the way on pages without hidden values', async () => {
    const page = await open(SITES[0]);
    await page.keyboard.type('Just a normal question');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    expect(await windowHeight(page)).toBe(0);
    await page.close();
  });
});

// ---------------------------------------------------------------------------
// Settings, Undo, the safety net and the toolbar popup
// ---------------------------------------------------------------------------

const worker = () => context.serviceWorkers()[0]!;
const extensionId = () => new URL(worker().url()).host;

/** The tab id of a page. Veil has no "tabs" permission, so tabs are found by focus, not by address. */
async function tabIdOf(page: Page): Promise<number> {
  await page.bringToFront();
  const id = await worker().evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
  expect(id).toBeDefined();
  return id!;
}

async function setUserSettings(settings: object | null): Promise<void> {
  await worker().evaluate(async (s) => {
    if (s) await chrome.storage.sync.set({ settings: s });
    else await chrome.storage.sync.remove('settings');
  }, settings);
}

/** Clicks the button in Veil's notice. It sits in a closed shadow root, so only the debugger can find it. */
async function clickNoticeButton(page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  interface DomNode { nodeId: number; nodeName: string; children?: DomNode[]; shadowRoots?: DomNode[] }
  const find = (node: DomNode, inNotice: boolean): DomNode | null => {
    const here = inNotice || node.nodeName === 'VEIL-NOTICE';
    if (here && node.nodeName === 'BUTTON') return node;
    for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
      const hit = find(child, here);
      if (hit) return hit;
    }
    return null;
  };
  let button: DomNode | null = null;
  await expect.poll(async () => {
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
    button = find(root, false);
    return button !== null;
  }).toBe(true);
  await page.waitForTimeout(250); // the notice fades in
  const { model } = (await cdp.send('DOM.getBoxModel', { nodeId: button!.nodeId })) as { model: { content: number[] } };
  const [x1, y1, , , x3, y3] = model.content as [number, number, number, number, number, number];
  await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
  await cdp.detach();
}

describe('Undo', () => {
  for (const site of [SITES[0], SITES[1]]) {
    it(`puts the text back and lets that one message through (${site.name})`, async () => {
      const page = await open(site);
      await page.keyboard.type(`Mail ${EMAIL} now`);
      await page.keyboard.press('Enter');
      await expect.poll(() => composerText(page)).toContain('[EMAIL_');
      await clickNoticeButton(page);
      await expect.poll(() => composerText(page)).toBe(`Mail ${EMAIL} now`);
      await page.locator(site.composer).click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await expect.poll(() => sent(page)).toEqual([`Mail ${EMAIL} now`]);
      // Only that one: the next message is checked again.
      await page.keyboard.type(`Again ${EMAIL}`);
      await page.keyboard.press('Enter');
      await expect.poll(() => composerText(page)).toContain('[EMAIL_');
      expect(await sent(page)).toHaveLength(1);
      await page.close();
    });
  }
});

describe('your settings', () => {
  afterAll(() => setUserSettings(null));

  it('switched off on a site: messages go through unchecked', async () => {
    await setUserSettings({ off: ['chatgpt.com'], disabled: [], allow: [], patterns: [] });
    const page = await open(SITES[0]);
    await page.keyboard.type(`Mail ${EMAIL}`);
    await page.keyboard.press('Enter');
    await expect.poll(() => sent(page)).toEqual([`Mail ${EMAIL}`]);
    await page.close();
    // Other sites stay protected.
    const other = await open(SITES[2]);
    await other.keyboard.type(`Mail ${EMAIL}`);
    await other.keyboard.press('Enter');
    await expect.poll(() => composerText(other)).toContain('[EMAIL_');
    await other.close();
  });

  it('keeps allowed values visible and hides your own patterns', async () => {
    await setUserSettings({ off: [], disabled: [], allow: [EMAIL], patterns: [{ type: 'PROJECT', pattern: 'PRJ-\\d{4}' }] });
    const page = await open(SITES[0]);
    await page.keyboard.type(`Mail ${EMAIL} about PRJ-1234 and bob@example.org`);
    await page.keyboard.press('Enter');
    await expect.poll(() => composerText(page)).toMatch(/^Mail jane\.doe@example\.org about \[PROJECT_1\] and \[EMAIL_\d+\]$/);
    await page.close();
  });

  it('applies changes to open tabs right away', async () => {
    await setUserSettings(null);
    const page = await open(SITES[0]);
    await setUserSettings({ off: [], disabled: ['EMAIL'], allow: [], patterns: [] });
    await page.waitForTimeout(200);
    await page.keyboard.type(`Mail ${EMAIL}`);
    await page.keyboard.press('Enter');
    await expect.poll(() => sent(page)).toEqual([`Mail ${EMAIL}`]);
    await page.close();
  });
});

describe('names and addresses', () => {
  it('hides a name and a postal address typed in the message box', async () => {
    const page = await open(SITES[2]);
    await page.keyboard.type('Write a letter to Jane Doe, 12 rue de la Paix, 75002 Paris.');
    await page.keyboard.press('Enter');
    await expect.poll(() => composerText(page)).toBe('Write a letter to [NAME_1], [ADDRESS_1].');
    await page.close();
  });
});

describe('safety net for site redesigns', () => {
  it('still masks on Enter in a message box it has no selector for', async () => {
    const page = await open(REDESIGN);
    await page.keyboard.type(`Mail ${EMAIL}`);
    await page.keyboard.press('Enter');
    await expect.poll(() => composerText(page)).toMatch(/^Mail \[EMAIL_\d+\]$/);
    await page.waitForTimeout(300);
    expect(await sent(page)).toEqual([]);
    await page.keyboard.press('Enter');
    await expect.poll(() => sent(page)).toEqual([expect.stringMatching(/^Mail \[EMAIL_\d+\]$/)]);
    await page.close();
  });

  it('still masks when an unknown send button is clicked', async () => {
    const page = await open(REDESIGN);
    await page.keyboard.type(`Key ${KEY}`);
    await page.locator(REDESIGN.send).click();
    await expect.poll(() => composerText(page)).toMatch(/^Key \[API_KEY_\d+\]$/);
    expect(await sent(page)).toEqual([]);
    await page.close();
  });

  it('warns on the toolbar icon when it finds no message box at all', async () => {
    const page = await context.newPage();
    await page.goto(REDESIGN.url);
    await page.evaluate(() => document.querySelector('.input-v2')?.remove());
    const tabId = await tabIdOf(page);
    await expect
      .poll(() => worker().evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId), { timeout: 12_000 })
      .toBe('!');
    await page.close();
  });
});

describe('extension frames', () => {
  it("can't be probed by the page, so a site can't tell Veil is installed until Veil shows something", async () => {
    const page = await open(SITES[0]);
    const probe = (file: string) =>
      page.evaluate((u) => fetch(u).then(() => 'open', () => 'closed'), `chrome-extension://${extensionId()}/${file}`);
    for (const file of ['overlay.html', 'panel.html', 'panel.js']) expect(await probe(file)).toBe('closed');
    // Veil's own frames still load.
    await page.keyboard.type(`Mail ${EMAIL}`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    const frame = await overlay(page);
    await expect.poll(async () => (await shownValues(frame)).length).toBe(2);
    await page.close();
  });
});

describe('toolbar popup', () => {
  afterAll(() => setUserSettings(null));

  async function openPopupFor(site: (typeof PAGES)[number]): Promise<{ page: Page; popup: Page }> {
    const page = await open(site);
    const tabId = await tabIdOf(page);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId()}/popup.html#tab=${tabId}`);
    return { page, popup };
  }

  it('shows the page status and what was hidden, and switches Veil off for the site', async () => {
    await setUserSettings(null);
    await worker().evaluate(() => chrome.storage.local.remove('audit'));
    const { page, popup } = await openPopupFor(SITES[0]);
    await page.bringToFront();
    await page.keyboard.type(`Mail ${EMAIL} and ${KEY}`);
    await page.keyboard.press('Enter');
    await expect.poll(() => composerText(page)).toContain('[API_KEY_');
    await popup.reload();
    await expect.poll(() => popup.locator('#site-line').innerText()).toMatch(/^On for ChatGPT · 2 hidden values on this page$/);
    await expect.poll(() => popup.locator('#audit').innerText()).toBe('1 email address and 1 API key.');
    // The audit log holds counts only.
    const audit = await worker().evaluate(() => chrome.storage.local.get('audit'));
    expect(JSON.stringify(audit)).not.toContain('jane');
    expect(JSON.stringify(audit)).not.toContain('sk-');

    await popup.getByLabel('Veil on this site').click({ force: true });
    await expect.poll(() => popup.locator('#site-line').innerText()).toMatch(/^Off for ChatGPT/);
    expect(await worker().evaluate(async () => (await chrome.storage.sync.get('settings')).settings.off)).toEqual(['chatgpt.com']);
    await page.close();
    await popup.close();
  });

  it('saves your rules and the kinds to hide, and explains mistakes', async () => {
    await setUserSettings(null);
    const { page, popup } = await openPopupFor(SITES[0]);
    await popup.getByLabel('Names').uncheck();
    await popup.locator('#allow').fill('support@acme.com\n*@example.net');
    await popup.locator('#patterns').fill('PROJECT PRJ-\\d{4}\nTICKET (');
    await popup.getByRole('button', { name: 'Save rules' }).click();
    await expect.poll(() => popup.locator('#problems').innerText()).toContain('TICKET');
    await popup.locator('#patterns').fill('PROJECT PRJ-\\d{4}');
    await popup.getByRole('button', { name: 'Save rules' }).click();
    await expect.poll(() => popup.locator('#saved').innerText()).toBe('Saved');
    const saved = await worker().evaluate(async () => (await chrome.storage.sync.get('settings')).settings);
    expect(saved).toEqual({
      off: [],
      disabled: ['NAME'],
      allow: ['support@acme.com', '*@example.net'],
      patterns: [{ type: 'PROJECT', pattern: 'PRJ-\\d{4}' }],
    });
    await page.close();
    await popup.close();
  });
});
