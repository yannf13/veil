/**
 * The overlay frame. It runs on the extension's own origin, so the AI site's scripts can't read
 * anything in it. It gets placeholder positions from the content script and real values from
 * session storage, and draws each value over its placeholder.
 */
import { Vault } from '@veil/engine';
import type { VaultEntry } from '@veil/engine';
import { SITE_ORIGINS, vaultKey } from './overlay-protocol';
import type { Chip, ChipsMessage } from './overlay-protocol';

const host = new URLSearchParams(location.hash.slice(1)).get('host') ?? '';
const key = vaultKey(host);
const container = document.getElementById('chips') as HTMLElement;
let vault = new Vault();
let chips: Chip[] = [];

void chrome.storage.session.get(key).then((stored) => {
  vault = Vault.fromJSON((stored[key] as VaultEntry[] | undefined) ?? []);
  render();
});
chrome.storage.session.onChanged.addListener((changes) => {
  const change = changes[key];
  if (!change) return;
  vault = Vault.fromJSON((change.newValue as VaultEntry[] | undefined) ?? []);
  render();
});

window.addEventListener('message', (e: MessageEvent<ChipsMessage>) => {
  // Only the page this frame was made for, and only for its own site's vault.
  if (e.source !== window.parent || !SITE_ORIGINS.includes(e.origin)) return;
  if (new URL(e.origin).hostname !== host) return;
  if (e.data?.type !== 'veil:chips' || !Array.isArray(e.data.chips)) return;
  chips = e.data.chips;
  render();
});

function render(): void {
  while (container.children.length > chips.length) container.lastElementChild?.remove();
  chips.forEach((chip, i) => {
    const el = (container.children[i] as HTMLElement | undefined) ?? container.appendChild(document.createElement('span'));
    const value = vault.valueOf(chip.placeholder);
    if (!value) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    if (el.textContent !== value) el.textContent = value;
    const s = el.style;
    s.font = chip.font; // the shorthand resets line-height, so set it after
    s.lineHeight = `${chip.h}px`;
    s.left = `${chip.x}px`;
    s.top = `${chip.y}px`;
    s.width = `${chip.w}px`;
    s.height = `${chip.h}px`;
    s.color = chip.color;
    s.background = chip.background;
    s.letterSpacing = chip.letterSpacing;
    s.clipPath = `inset(${chip.clip.map((n) => `${n}px`).join(' ')})`;
    fit(el, chip.font);
  });
}

/**
 * This frame doesn't have the site's web fonts, so a value can come out wider than the space
 * reserved for it. Shrink it a little first; only cut it off (with an ellipsis) past 80%.
 */
function fit(el: HTMLElement, font: string): void {
  el.style.font = font;
  el.style.lineHeight = el.style.height;
  if (el.scrollWidth <= el.clientWidth) return;
  const size = parseFloat(getComputedStyle(el).fontSize);
  const ratio = Math.max(0.8, el.clientWidth / el.scrollWidth);
  el.style.fontSize = `${size * ratio}px`;
}
