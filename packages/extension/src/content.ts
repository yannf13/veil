import { describeFindings, detect, findPlaceholders, tally, Vault } from '@veil/engine';
import type { Finding } from '@veil/engine';
import { isTextField, linearize, rangeFor, readText } from './dom-text';
import type { GetTabInfoMessage, TabInfo, TabState, VeilMessage } from './messages';
import { PanelHost } from './panel-host';
import { Reveal } from './reveal';
import { combine, EMPTY_USER, loadSettings, onSettingsChange } from './settings';
import { composerOf, editableOf, findComposer, isSendButton, looksLikeSendFor, siteFor } from './sites';
import type { Site } from './sites';
import { hideNotice, isNotice, showNotice } from './toast';
import { loadVault, onVaultChange, saveVault } from './vault-store';

/*
 * How it works:
 * 1. When you send (Enter, the send button, or a form submit), Veil scans the message box.
 *    Nothing sensitive: the message goes through untouched.
 * 2. Something sensitive: Veil stops the send, replaces each value with a placeholder such as
 *    [EMAIL_1] right in the box, and asks you to look and send again. You always see exactly
 *    what leaves your device. If a value can't be replaced, nothing is sent. "Undo" puts your
 *    text back and lets that one message go as you wrote it.
 * 3. Placeholders on the page (your sent message, the AI's answer) stay placeholders in the page.
 *    The real values are drawn over them by a frame the site can't read (see reveal.ts), and
 *    listed with Copy buttons in the Veil window, another such frame (see panel-host.ts).
 *    Real values are never written into the page, and message boxes are only changed when you send.
 *
 * Veil starts before the page's own scripts (document_start) and listens on window in the capture
 * phase, so no handler of the site can see a send before Veil does.
 */

const host = location.hostname;
const site = siteFor(host);
if (site) start(site);

/** How long "Undo" lets the next send through unchecked. */
const BYPASS_MS = 2 * 60_000;
const BLIND_AFTER_MS = 6000;

function start(site: Site): void {
  let vault = new Vault();
  let settings = combine(EMPTY_USER, null);
  let busy = false;
  let bypassUntil = 0;
  /** The last message box you typed in: the safety net when the site's markup changed. */
  let lastEditable: HTMLElement | null = null;
  let panel: PanelHost | null = null;
  let reveal: Reveal | null = null;
  let hiddenOnPage = 0;

  const scan = (text: string): Finding[] => detect(text, settings.policy.options);
  const isOn = (): boolean => settings.isOn(host);
  const currentComposer = (): HTMLElement | null =>
    findComposer(site) ?? (lastEditable?.isConnected ? lastEditable : null);

  void loadSettings().then((s) => {
    settings = s;
    reportStatus();
  });
  onSettingsChange((s) => {
    settings = s;
    reportStatus();
  });

  // Capture phase on window: the very first listener of every event on the page.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing) return;
      const composer = composerOf(site, e.target) ?? editableOf(e.target);
      if (composer) guard(e, composer);
    },
    true,
  );
  window.addEventListener(
    'click',
    (e) => {
      if (isSendButton(site, e.target)) {
        const composer = currentComposer();
        if (composer) guard(e, composer);
      } else if (looksLikeSendFor(e.target, lastEditable)) {
        guard(e, lastEditable!);
      }
    },
    true,
  );
  window.addEventListener(
    'submit',
    (e) => {
      const composer = currentComposer();
      if (composer && e.target instanceof Element && e.target.contains(composer)) guard(e, composer);
    },
    true,
  );
  window.addEventListener(
    'focusin',
    (e) => {
      const box = composerOf(site, e.target) ?? editableOf(e.target);
      if (box) lastEditable = box;
    },
    true,
  );

  chrome.runtime.onMessage.addListener((message: GetTabInfoMessage, _sender, reply: (info: TabInfo) => void) => {
    if (message?.type !== 'veil:tab-info') return;
    reply({ host, site: site.name, state: tabState(), hidden: hiddenOnPage });
  });

  const startDisplay = (): void => {
    panel = new PanelHost(host, () => {
      const composer = currentComposer();
      return (composer?.closest('form') ?? composer)?.getBoundingClientRect() ?? null;
    });
    reveal = new Reveal(
      host,
      () => vault,
      (node) => isInEditable(node) || isNotice(node),
      (placeholders) => {
        hiddenOnPage = placeholders.length;
        panel?.show(placeholders);
      },
    );
    reveal.start();
    // Any change to the page's text may add, move or remove placeholders.
    new MutationObserver(() => reveal?.invalidate()).observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    void loadVault(host).then((v) => {
      vault = v;
      reveal?.invalidate();
    });
    onVaultChange(host, (v) => {
      vault = v;
      reveal?.invalidate();
    });
    reportStatus();
    setInterval(reportStatus, 2000); // the message box comes and goes as you navigate
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startDisplay, { once: true });
  else startDisplay();

  /** Pages build their message box late; only call the page "blind" once it has stayed so for a while. */
  let blindSince: number | null = null;
  function tabState(): TabState {
    if (!isOn()) return 'off';
    if (currentComposer()) {
      blindSince = null;
      return 'ok';
    }
    blindSince ??= Date.now();
    return Date.now() - blindSince >= BLIND_AFTER_MS ? 'blind' : 'ok';
  }

  let lastState: TabState | null = null;
  function reportStatus(): void {
    const state = tabState();
    if (state === lastState) return;
    lastState = state;
    send({ type: 'veil:status', state });
  }

  function guard(e: Event, composer: HTMLElement): void {
    if (!isOn()) return;
    if (busy) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (Date.now() < bypassUntil) {
      bypassUntil = 0; // you chose to send this one as written
      return;
    }
    if (scan(readText(composer)).length === 0) {
      hideNotice(); // nothing sensitive: let it go
      return;
    }
    // Stop the send synchronously, before any site handler sees the event.
    e.preventDefault();
    e.stopImmediatePropagation();
    busy = true;
    void maskComposer(composer).finally(() => {
      busy = false;
    });
  }

  async function maskComposer(composer: HTMLElement): Promise<void> {
    vault = await loadVault(host); // pick up placeholders other tabs of this site added
    const original = isTextField(composer) ? composer.value : null;
    const masked: Finding[] = [];
    const ok = isTextField(composer) ? maskTextField(composer, masked) : await maskEditable(composer, masked);
    if (masked.length > 0) {
      await saveVault(host, vault);
      send({ type: 'veil:audit', counts: tally(masked) });
    }
    reveal?.invalidate(); // a textarea's new value changes no DOM node, so tell the window directly
    const left = scan(readText(composer)).length;
    if (!ok || left > 0) {
      showNotice(
        `couldn't hide ${left > 0 ? left : 'some'} sensitive value${left === 1 ? '' : 's'} in this box, so nothing was sent. Remove ${left === 1 ? 'it' : 'them'} by hand or try again.`,
        'error',
        10000,
      );
      return;
    }
    const swaps = masked.map((f) => ({ placeholder: vault.placeholderFor(f.type, f.value), value: f.value }));
    showNotice(`hid ${describeFindings(masked, settings.policy.labels)}. Check the message, then send again.`, 'info', 12000, {
      label: 'Undo',
      run: () => void undo(composer, original, swaps),
    });
  }

  /** Puts your text back as you wrote it and lets the next send through unchecked. */
  async function undo(
    composer: HTMLElement,
    original: string | null,
    swaps: Array<{ placeholder: string; value: string }>,
  ): Promise<void> {
    let ok = true;
    if (isTextField(composer) && original !== null) {
      setFieldValue(composer, original);
    } else {
      const valueOf = new Map(swaps.map((s) => [s.placeholder, s.value]));
      for (let i = 0; i < swaps.length + 3; i++) {
        const lin = linearize(composer);
        const last = findPlaceholders(lin.text).filter((p) => valueOf.has(p.placeholder)).at(-1);
        if (!last) break;
        const range = rangeFor(lin, last.start, last.end);
        if (!range || !(await replaceRange(composer, range, valueOf.get(last.placeholder)!))) {
          ok = false;
          break;
        }
      }
    }
    reveal?.invalidate();
    if (!ok) {
      showNotice("couldn't put everything back. Edit the message by hand.", 'error', 8000);
      return;
    }
    bypassUntil = Date.now() + BYPASS_MS;
    composer.focus();
    showNotice('put your text back as you wrote it. Your next send goes through unchanged.', 'info', 6000);
  }

  function maskTextField(field: HTMLTextAreaElement | HTMLInputElement, masked: Finding[]): boolean {
    const text = field.value;
    let out = '';
    let cursor = 0;
    for (const f of scan(text)) {
      out += text.slice(cursor, f.start) + vault.placeholderFor(f.type, f.value);
      cursor = f.end;
      masked.push(f);
    }
    out += text.slice(cursor);
    setFieldValue(field, out);
    return true;
  }

  async function maskEditable(composer: HTMLElement, masked: Finding[]): Promise<boolean> {
    // Replace from the last value backwards and re-read the box each time:
    // editors re-render after every change, so earlier DOM positions go stale.
    const limit = scan(readText(composer)).length + 3;
    for (let i = 0; i < limit; i++) {
      const lin = linearize(composer);
      const f = scan(lin.text).at(-1);
      if (!f) return true;
      const range = rangeFor(lin, f.start, f.end);
      if (!range) return false;
      if (!(await replaceRange(composer, range, vault.placeholderFor(f.type, f.value)))) return false;
      masked.unshift(f); // keep message order for the notice
    }
    return scan(readText(composer)).length === 0;
  }
}

/** Sets a textarea's value through the prototype's setter, so frameworks such as React notice the change. */
function setFieldValue(field: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
  if (setter) setter.call(field, value);
  else field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Messages to the background worker. After an extension update the old script can't reach it: ignore. */
function send(message: VeilMessage): void {
  try {
    void chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // extension context invalidated
  }
}

function isInEditable(node: Node): boolean {
  return !!node.parentElement?.closest(
    '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], textarea, input',
  );
}

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

/** Replaces the words in `range` with `text` the way typing would, so the editor updates its own state. */
async function replaceRange(composer: HTMLElement, range: Range, text: string): Promise<boolean> {
  const selection = window.getSelection();
  if (!selection) return false;
  composer.focus();
  selection.removeAllRanges();
  selection.addRange(range);
  await nextFrame(); // editors pick up selection changes asynchronously
  const before = readText(composer);
  if (document.execCommand('insertText', false, text)) {
    await nextFrame();
    if (readText(composer) !== before) return true;
  }
  // Fallback: a synthetic paste, which ProseMirror, Quill and Lexical all handle.
  const data = new DataTransfer();
  data.setData('text/plain', text);
  composer.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  await nextFrame();
  return readText(composer) !== before;
}
