/**
 * Puts the Veil window on the page and keeps it told which placeholders are present.
 * Only placeholder names go to the window and only its height comes back: nothing the page
 * could read here says anything about the real values.
 */
import type { PanelMessage, PanelSizeMessage } from './overlay-protocol';

const WIDTH = 320;
const MAX_HEIGHT = 300;
/** Leaves room for Veil's notices, which use the bottom-right corner. */
const BOTTOM = 88;

export class PanelHost {
  private frame: HTMLIFrameElement | null = null;
  private ready = false;
  private list: string[] = [];
  private lastSent = '';
  private readonly origin = new URL(chrome.runtime.getURL('')).origin;

  constructor(
    private readonly host: string,
    /** Area the window must never cover, such as the message box and its send button. */
    private readonly avoid: () => DOMRect | null = () => null,
  ) {
    window.addEventListener('message', (e: MessageEvent<PanelSizeMessage>) => {
      if (!this.frame || e.source !== this.frame.contentWindow || e.origin !== this.origin) return;
      if (e.data?.type === 'veil:panel-size' && typeof e.data.height === 'number') this.setHeight(e.data.height);
    });
    window.addEventListener('resize', () => this.place(), { passive: true });
    setInterval(() => this.place(), 500); // the message box grows as you type
  }

  /** Bottom-right corner, lifted above the message box whenever the two would overlap. */
  private place(): void {
    if (!this.frame?.isConnected) return;
    const height = this.frame.getBoundingClientRect().height;
    let bottom = BOTTOM;
    const r = this.avoid();
    if (r && r.width > 0) {
      const left = window.innerWidth - 16 - WIDTH;
      const right = window.innerWidth - 16;
      const top = window.innerHeight - bottom - height;
      const overlaps = r.left < right && r.right > left && r.top < window.innerHeight - bottom && r.bottom > top;
      if (overlaps) bottom = Math.max(bottom, window.innerHeight - r.top + 12);
    }
    this.frame.style.setProperty('bottom', `${bottom}px`, 'important');
  }

  /** The placeholders on the page, in order. An empty list hides the window. */
  show(placeholders: string[]): void {
    this.list = placeholders;
    const json = JSON.stringify(placeholders);
    if (json === this.lastSent && this.frame?.isConnected) return;
    if (placeholders.length === 0 && !this.frame?.isConnected) return;
    this.ensureFrame();
    if (!this.ready || !this.frame?.contentWindow) return; // sent on load
    const message: PanelMessage = { type: 'veil:panel', placeholders };
    this.frame.contentWindow.postMessage(message, this.origin);
    this.lastSent = json;
  }

  /**
   * Shows the window at its content's height, or hides it at 0. Hidden means invisible and
   * click-through but still laid out (1px tall): a display:none frame never lays out, so it
   * could never measure itself to come back.
   */
  private setHeight(height: number): void {
    if (!this.frame) return;
    const h = Math.max(0, Math.min(height, MAX_HEIGHT));
    const s = this.frame.style;
    s.setProperty('height', `${Math.max(h, 1)}px`, 'important');
    s.setProperty('opacity', h > 0 ? '1' : '0', 'important');
    s.setProperty('pointer-events', h > 0 ? 'auto' : 'none', 'important');
    this.place();
  }

  private ensureFrame(): void {
    if (this.frame?.isConnected) return;
    const frame = document.createElement('iframe');
    frame.src = `${chrome.runtime.getURL('panel.html')}#host=${encodeURIComponent(this.host)}`;
    frame.title = 'Veil';
    frame.allow = 'clipboard-write';
    frame.setAttribute(
      'style',
      [
        'position: fixed', 'right: 16px', `bottom: ${BOTTOM}px`, `width: ${WIDTH}px`, 'height: 1px', 'display: block',
        'opacity: 0', 'pointer-events: none', 'border: 0', 'margin: 0', 'padding: 0', 'border-radius: 12px',
        'overflow: hidden', 'box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18)', 'z-index: 2147483647',
        'background: transparent', 'color-scheme: normal', 'visibility: visible', 'transform: none',
        'max-width: calc(100vw - 32px)',
      ]
        .map((d) => `${d} !important`)
        .join('; '),
    );
    this.ready = false;
    frame.addEventListener('load', () => {
      this.ready = true;
      this.lastSent = '';
      this.show(this.list);
    });
    document.documentElement.appendChild(frame);
    this.frame = frame;
  }
}
