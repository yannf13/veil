/**
 * Shows real values on screen without ever putting them in the page.
 *
 * The page keeps the placeholders. Each one gets blank padding (figure spaces) up to the width of
 * its real value, so the line has room for it. A transparent frame on the extension's own origin,
 * which the site's scripts can't read, draws the value over that spot. This side only measures and
 * sends positions and styles; the frame reads the values itself.
 *
 * Trade-off: padding tells the page roughly how wide a value is. Nothing else about it.
 */
import { findPlaceholders } from '@veil/engine';
import type { Vault } from '@veil/engine';
import type { Chip, ChipsMessage } from './overlay-protocol';

/**
 * Padding characters: blank and never a line break. Figure spaces do the bulk, narrow no-break
 * spaces fill the rest, so the reserved room matches the value to within a few pixels.
 */
const PAD = ' ';
const FINE_PAD = ' ';
const isPad = (ch: string | undefined): boolean => ch === PAD || ch === FINE_PAD;

export class Reveal {
  private frame: HTMLIFrameElement | null = null;
  private frameReady = false;
  private nodes: Text[] = [];
  private dirty = true;
  private scheduled = false;
  private lastSent = '[]';
  private pending: Chip[] = [];
  private readonly ctx = document.createElement('canvas').getContext('2d');
  private readonly origin = new URL(chrome.runtime.getURL('')).origin;

  constructor(
    private readonly host: string,
    private readonly getVault: () => Vault,
    private readonly skip: (node: Node) => boolean,
  ) {}

  start(): void {
    const schedule = (): void => this.schedule();
    document.addEventListener('scroll', schedule, { capture: true, passive: true }); // any scrolling area
    window.addEventListener('resize', schedule, { passive: true });
    window.visualViewport?.addEventListener('resize', schedule);
    setInterval(schedule, 1000); // layout changes no event reports: animations, late web fonts
  }

  /** The page's text or the vault changed: rescan before the next draw. */
  invalidate(): void {
    this.dirty = true;
    this.schedule();
  }

  schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.update();
    });
  }

  private update(): void {
    const vault = this.getVault();
    if (this.dirty) {
      this.dirty = false;
      this.nodes = vault.size > 0 ? this.scan() : [];
      for (const node of this.nodes) this.pad(node, vault);
    }
    const chips: Chip[] = [];
    for (const node of this.nodes) this.collect(node, vault, chips);
    this.send(chips);
  }

  private scan(): Text[] {
    const found: Text[] = [];
    if (!document.body) return found;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      if (t.data.includes('[') && !this.skip(t)) found.push(t);
    }
    return found;
  }

  /** Adjusts the padding after each known placeholder so the line has room for its value. */
  private pad(node: Text, vault: Vault): void {
    const parent = node.parentElement;
    if (!parent || !this.ctx) return;
    const text = node.data;
    const matches = findPlaceholders(text);
    if (matches.length === 0) return;
    const font = fontOf(getComputedStyle(parent));
    const room = lineRoom(parent);
    let out = '';
    let cursor = 0;
    for (const m of matches) {
      const value = vault.valueOf(m.placeholder);
      const pads = countPads(text, m.end);
      out += text.slice(cursor, m.end);
      cursor = m.end + pads;
      const shown = text.slice(m.start, m.end);
      out += value ? this.paddingFor(shown, value, font, room) : text.slice(m.end, m.end + pads);
    }
    out += text.slice(cursor);
    if (out !== text) node.data = out; // our own mutation; the next scan finds it already padded
  }

  /** Blank padding that makes `shown` (the placeholder) as wide as `value`, capped at the line's width. */
  private paddingFor(shown: string, value: string, font: string, room: number): string {
    const ctx = this.ctx!;
    ctx.font = font;
    const gap = Math.min(ctx.measureText(value).width, room * 0.95) - ctx.measureText(shown).width;
    if (gap <= 0) return '';
    const wide = ctx.measureText(PAD).width || 1;
    const fine = ctx.measureText(FINE_PAD).width;
    if (fine < 0.5) return PAD.repeat(Math.ceil(gap / wide)); // font without a usable narrow space
    const bulk = Math.floor(gap / wide);
    return PAD.repeat(bulk) + FINE_PAD.repeat(Math.ceil((gap - bulk * wide) / fine));
  }

  private collect(node: Text, vault: Vault, chips: Chip[]): void {
    const parent = node.parentElement;
    if (!parent || !node.isConnected) return;
    for (const m of findPlaceholders(node.data)) {
      if (!vault.valueOf(m.placeholder)) continue;
      const range = document.createRange();
      range.setStart(node, m.start);
      range.setEnd(node, m.end + countPads(node.data, m.end));
      const rect = range.getClientRects()[0];
      if (!rect || rect.width === 0 || rect.height === 0) continue;
      const clip = clipFor(parent, rect);
      if (!clip || isCovered(parent, rect)) continue;
      const style = getComputedStyle(parent);
      chips.push({
        placeholder: m.placeholder,
        x: rect.left,
        y: rect.top,
        w: rect.width,
        h: rect.height,
        font: fontOf(style),
        color: style.color,
        background: backgroundOf(parent, style.color),
        letterSpacing: style.letterSpacing,
        clip,
      });
    }
  }

  private send(chips: Chip[]): void {
    const json = JSON.stringify(chips);
    if (json === this.lastSent && this.frame?.isConnected) return;
    if (chips.length > 0 || this.frame) this.ensureFrame();
    this.pending = chips;
    if (!this.frameReady || !this.frame?.contentWindow) return; // sent on load
    const message: ChipsMessage = { type: 'veil:chips', chips };
    this.frame.contentWindow.postMessage(message, this.origin);
    this.lastSent = json;
  }

  private ensureFrame(): void {
    if (this.frame?.isConnected) return;
    // Created on first use, and again if the page removes it.
    const frame = document.createElement('iframe');
    frame.src = `${chrome.runtime.getURL('overlay.html')}#host=${encodeURIComponent(this.host)}`;
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.setAttribute(
      'style',
      [
        'position: fixed', 'inset: 0', 'width: 100vw', 'height: 100vh', 'border: 0', 'margin: 0', 'padding: 0',
        'background: transparent', 'pointer-events: none', 'z-index: 2147483646', 'display: block',
        'color-scheme: light', 'opacity: 1', 'visibility: visible', 'transform: none',
      ]
        .map((d) => `${d} !important`)
        .join('; '),
    );
    this.frameReady = false;
    frame.addEventListener('load', () => {
      this.frameReady = true;
      this.lastSent = '';
      this.send(this.pending);
    });
    document.documentElement.appendChild(frame);
    this.frame = frame;
  }

  isOwnFrame(node: Node): boolean {
    return node === this.frame;
  }
}

function countPads(text: string, from: number): number {
  let n = 0;
  while (isPad(text[from + n])) n++;
  return n;
}

function fontOf(style: CSSStyleDeclaration): string {
  return style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

/** Width of the nearest block around the text: a value padded wider than this would overflow. */
function lineRoom(el: Element): number {
  for (let a: Element | null = el; a; a = a.parentElement) {
    if (!getComputedStyle(a).display.startsWith('inline')) return a.getBoundingClientRect().width;
  }
  return window.innerWidth;
}

/** Insets that keep the value inside every scrolling or clipping box around it, or null if fully hidden. */
function clipFor(el: Element, r: DOMRect): Chip['clip'] | null {
  let top = 0;
  let left = 0;
  let right = window.innerWidth;
  let bottom = window.innerHeight;
  for (let a: Element | null = el; a && a !== document.documentElement; a = a.parentElement) {
    const s = getComputedStyle(a);
    if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
    const b = a.getBoundingClientRect();
    top = Math.max(top, b.top);
    left = Math.max(left, b.left);
    right = Math.min(right, b.right);
    bottom = Math.min(bottom, b.bottom);
  }
  const inset: Chip['clip'] = [
    Math.max(0, top - r.top),
    Math.max(0, r.right - right),
    Math.max(0, r.bottom - bottom),
    Math.max(0, left - r.left),
  ];
  if (inset[0] + inset[2] >= r.height || inset[1] + inset[3] >= r.width) return null;
  return inset;
}

/** True when something else (a menu, a dialog) is drawn over the placeholder. */
function isCovered(el: Element, r: DOMRect): boolean {
  const x = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1);
  const y = Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1);
  const top = document.elementFromPoint(x, y);
  if (!top) return false;
  return !(top === el || el.contains(top) || top.contains(el));
}

/** The colour actually painted behind the text, so the value can hide its placeholder. */
function backgroundOf(el: Element, textColor: string): string {
  for (let a: Element | null = el; a; a = a.parentElement) {
    const bg = getComputedStyle(a).backgroundColor;
    if (!isTransparent(bg)) return bg;
  }
  // Nothing painted: guess from the text colour (dark text means a light page).
  return luminance(textColor) < 0.5 ? '#ffffff' : '#000000';
}

function isTransparent(color: string): boolean {
  return color === 'transparent' || /rgba?\([^)]*,\s*0\)$/.test(color) || /\/\s*0\)$/.test(color);
}

function luminance(color: string): number {
  const [r = 0, g = 0, b = 0] = (color.match(/\d+(\.\d+)?/g) ?? []).map(Number);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
