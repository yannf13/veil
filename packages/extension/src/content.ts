import { detect, Vault } from '@veil/engine';
import type { EntityType, Finding } from '@veil/engine';
import { isTextField, linearize, rangeFor, readText } from './dom-text';
import { Reveal } from './reveal';
import { composerOf, findComposer, isSendButton, siteFor } from './sites';
import type { Site } from './sites';
import { hideNotice, isNotice, showNotice } from './toast';
import { loadVault, onVaultChange, saveVault } from './vault-store';

/*
 * How it works:
 * 1. When you send (Enter, the send button, or a form submit), Veil scans the message box.
 *    Nothing sensitive: the message goes through untouched.
 * 2. Something sensitive: Veil stops the send, replaces each value with a placeholder such as
 *    [EMAIL_1] right in the box, and asks you to look and send again. You always see exactly
 *    what leaves your device. If a value can't be replaced, nothing is sent.
 * 3. Placeholders on the page (your sent message, the AI's answer) stay placeholders in the page.
 *    The real values are drawn over them by a frame the site can't read (see reveal.ts).
 *    Real values are never written into the page, and message boxes are never touched.
 */

const host = location.hostname;
const site = siteFor(host);
if (site) start(site);

function start(site: Site): void {
  let vault = new Vault();
  let busy = false;
  const reveal = new Reveal(host, () => vault, (node) => isInEditable(node) || isNotice(node));
  reveal.start();

  void loadVault(host).then((v) => {
    vault = v;
    reveal.invalidate();
  });
  onVaultChange(host, (v) => {
    vault = v;
    reveal.invalidate();
  });

  // Capture phase on document: runs before the editor's and the site's own handlers.
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing) return;
      const composer = composerOf(site, e.target);
      if (composer) guard(e, composer);
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      if (!isSendButton(site, e.target)) return;
      const composer = findComposer(site);
      if (composer) guard(e, composer);
    },
    true,
  );
  document.addEventListener(
    'submit',
    (e) => {
      const composer = findComposer(site);
      if (composer && e.target instanceof Element && e.target.contains(composer)) guard(e, composer);
    },
    true,
  );

  function guard(e: Event, composer: HTMLElement): void {
    if (busy) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (detect(readText(composer)).length === 0) {
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
    const masked: Finding[] = [];
    const ok = isTextField(composer) ? maskTextField(composer, masked) : await maskEditable(composer, masked);
    if (masked.length > 0) await saveVault(host, vault);
    const left = detect(readText(composer)).length;
    if (!ok || left > 0) {
      showNotice(
        `couldn't hide ${left > 0 ? left : 'some'} sensitive value${left === 1 ? '' : 's'} in this box, so nothing was sent. Remove ${left === 1 ? 'it' : 'them'} by hand or try again.`,
        'error',
        10000,
      );
      return;
    }
    showNotice(`hid ${describe(masked)}. Check the message, then send again.`);
  }

  function maskTextField(field: HTMLTextAreaElement | HTMLInputElement, masked: Finding[]): boolean {
    const text = field.value;
    let out = '';
    let cursor = 0;
    for (const f of detect(text)) {
      out += text.slice(cursor, f.start) + vault.placeholderFor(f.type, f.value);
      cursor = f.end;
      masked.push(f);
    }
    out += text.slice(cursor);
    // Use the prototype's setter so frameworks such as React notice the change.
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
    if (setter) setter.call(field, out);
    else field.value = out;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  async function maskEditable(composer: HTMLElement, masked: Finding[]): Promise<boolean> {
    // Replace from the last value backwards and re-read the box each time:
    // editors re-render after every change, so earlier DOM positions go stale.
    const limit = detect(readText(composer)).length + 3;
    for (let i = 0; i < limit; i++) {
      const lin = linearize(composer);
      const f = detect(lin.text).at(-1);
      if (!f) return true;
      const range = rangeFor(lin, f.start, f.end);
      if (!range) return false;
      if (!(await replaceRange(composer, range, vault.placeholderFor(f.type, f.value)))) return false;
      masked.unshift(f); // keep message order for the notice
    }
    return detect(readText(composer)).length === 0;
  }

  // Any change to the page's text may add, move or remove placeholders.
  new MutationObserver(() => reveal.invalidate()).observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  });
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

const LABELS: Record<EntityType, [string, string]> = {
  EMAIL: ['email address', 'email addresses'],
  PHONE: ['phone number', 'phone numbers'],
  IBAN: ['IBAN', 'IBANs'],
  CARD: ['card number', 'card numbers'],
  IP: ['IP address', 'IP addresses'],
  API_KEY: ['API key', 'API keys'],
  PRIVATE_KEY: ['private key', 'private keys'],
  JWT: ['access token', 'access tokens'],
  SECRET: ['password or secret', 'passwords or secrets'],
};

/** "2 email addresses, 1 IBAN and 1 API key" */
export function describe(findings: readonly Finding[]): string {
  const counts = new Map<EntityType, number>();
  for (const f of findings) counts.set(f.type, (counts.get(f.type) ?? 0) + 1);
  const parts = [...counts].map(([type, n]) => `${n} ${LABELS[type][n === 1 ? 0 : 1]}`);
  return parts.length <= 1 ? (parts[0] ?? 'nothing') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}
