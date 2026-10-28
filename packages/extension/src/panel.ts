/**
 * The Veil window. Like the overlay, it runs on the extension's own origin, so the AI site can't
 * read it. It lists the hidden values on the page with a Copy button for each. The page only
 * tells it which placeholders are present; the values come from session storage.
 */
import { Vault } from '@veil/engine';
import type { VaultEntry } from '@veil/engine';
import { SITE_ORIGINS, vaultKey } from './overlay-protocol';
import type { PanelMessage, PanelSizeMessage } from './overlay-protocol';

const host = new URLSearchParams(location.hash.slice(1)).get('host') ?? '';
const key = vaultKey(host);
const MINIMIZED = 'panel:minimized';
const root = document.getElementById('root') as HTMLElement;

let vault = new Vault();
let placeholders: string[] = [];
let minimized = false;
let parentOrigin: string | null = null;

void chrome.storage.session.get([key, MINIMIZED]).then((stored) => {
  vault = Vault.fromJSON((stored[key] as VaultEntry[] | undefined) ?? []);
  minimized = stored[MINIMIZED] === true;
  render();
});
chrome.storage.session.onChanged.addListener((changes) => {
  const change = changes[key];
  if (!change) return;
  vault = Vault.fromJSON((change.newValue as VaultEntry[] | undefined) ?? []);
  render();
});

window.addEventListener('message', (e: MessageEvent<PanelMessage>) => {
  if (e.source !== window.parent || !SITE_ORIGINS.includes(e.origin)) return;
  if (new URL(e.origin).hostname !== host) return;
  if (e.data?.type !== 'veil:panel' || !Array.isArray(e.data.placeholders)) return;
  parentOrigin = e.origin;
  placeholders = e.data.placeholders.filter((p) => typeof p === 'string');
  render();
});

function setMinimized(value: boolean): void {
  minimized = value;
  void chrome.storage.session.set({ [MINIMIZED]: value });
  render();
}

function render(): void {
  const rows = placeholders.flatMap((p) => {
    const value = vault.valueOf(p);
    return value ? [{ placeholder: p, value }] : [];
  });
  root.replaceChildren();
  if (rows.length > 0) {
    root.append(minimized ? pill(rows.length) : card(rows));
  }
  reportHeight();
}

function pill(count: number): HTMLElement {
  const button = el('button', 'pill', `Veil · ${count} hidden value${count === 1 ? '' : 's'} — show`);
  button.addEventListener('click', () => setMinimized(false));
  return button;
}

function card(rows: Array<{ placeholder: string; value: string }>): HTMLElement {
  const card = el('div', 'card');
  const header = el('header');
  const hide = el('button', '', 'Hide');
  hide.title = 'Minimize the Veil window';
  hide.addEventListener('click', () => setMinimized(true));
  header.append(el('b', '', 'Veil'), el('small', '', 'only you see these'), hide);

  const list = el('ul');
  for (const { placeholder, value } of rows) {
    const value_ = el('span', 'value', value);
    value_.title = value;
    const copy = el('button', '', 'Copy');
    copy.addEventListener('click', () => void copyValue(value, copy));
    const item = el('li');
    item.append(el('code', '', placeholder), value_, copy);
    list.append(item);
  }
  card.append(header, list);
  return card;
}

async function copyValue(value: string, button: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // Clipboard API not delegated to this frame: fall back to a selection copy inside the frame.
    const area = document.createElement('textarea');
    area.value = value;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  button.textContent = 'Copied';
  setTimeout(() => (button.textContent = 'Copy'), 1500);
}

function reportHeight(): void {
  if (!parentOrigin) return;
  // Measured right away (forces layout): the frame may be hidden, and hidden frames get no animation frames.
  const height = Math.ceil(root.getBoundingClientRect().height);
  const message: PanelSizeMessage = { type: 'veil:panel-size', height };
  window.parent.postMessage(message, parentOrigin);
}

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
