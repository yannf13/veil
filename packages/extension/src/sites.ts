/**
 * Where the message box and the send button are on each supported site.
 * Selectors are tried in order. Language-independent attributes come first:
 * aria-labels change with the interface language ("Envoyer", "Senden").
 */
export interface Site {
  name: string;
  composer: string[];
  sendButton: string[];
}

/**
 * Sites redesign often: in Oct 2026 logged-out ChatGPT dropped its ProseMirror box (#prompt-textarea)
 * for a plain <textarea> in a <form>, with almost no data-testid left. So every site also gets the
 * generic rules below: a message box inside a form, and that form's submit or "send" button.
 */
const GENERIC_COMPOSER = [
  'form textarea',
  'form [contenteditable="true"]',
  'fieldset [contenteditable="true"]',
  '[role="textbox"][contenteditable="true"]',
];

const SITES: Record<string, Site> = {
  'chatgpt.com': {
    name: 'ChatGPT',
    composer: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', ...GENERIC_COMPOSER],
    sendButton: ['[data-testid="send-button"]', '#composer-submit-button'],
  },
  'claude.ai': {
    name: 'Claude',
    composer: ['div.ProseMirror[contenteditable="true"]', ...GENERIC_COMPOSER],
    sendButton: ['button[aria-label="Send message" i]'],
  },
  'gemini.google.com': {
    name: 'Gemini',
    composer: ['rich-textarea .ql-editor[contenteditable="true"]', '.ql-editor[contenteditable="true"]', ...GENERIC_COMPOSER],
    sendButton: ['button.send-button', 'button[aria-label="Send message" i]'],
  },
};

/** Words that mean "send" in the languages people use these sites in, for buttons we can't match otherwise. */
const SEND_LABEL = /(send|submit|envoyer|senden|enviar|invia|verzenden|wyślij|отправ|发送|送信)/i;

const EDITABLE = 'textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';

/**
 * The editable box `target` is in, whatever the site's markup: the safety net for redesigns that
 * break the selectors above. One-line inputs are left out (search boxes, sign-in forms).
 */
export function editableOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  let el = target.closest<HTMLElement>(EDITABLE);
  if (!el) return null;
  // The editing host is the outermost editable element.
  for (let up = el.parentElement?.closest<HTMLElement>(EDITABLE); up; up = up.parentElement?.closest<HTMLElement>(EDITABLE)) el = up;
  return el;
}

/** A button that reads as "send" (by label, title or type) and sits next to the given box. */
export function looksLikeSendFor(target: EventTarget | null, box: HTMLElement | null): boolean {
  if (!(target instanceof Element) || !box?.isConnected) return false;
  const button = target.closest<HTMLElement>('button, [role="button"]');
  if (!button || box.contains(button)) return false;
  const label = [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent].join(' ');
  const isSubmit = button instanceof HTMLButtonElement && button.type === 'submit' && !!button.form;
  if (!isSubmit && !SEND_LABEL.test(label)) return false;
  // Next to the box: they share an ancestor a few levels up, as a composer and its send button do.
  let shared: Element | null = box;
  for (let i = 0; i < 6 && shared; i++, shared = shared.parentElement) if (shared.contains(button)) return true;
  return false;
}

export function siteFor(hostname: string): Site | undefined {
  return SITES[hostname.replace(/^www\./, '')];
}

function isVisible(el: Element): boolean {
  // checkVisibility ignores the viewport size, so it also works in background or hidden tabs.
  if (typeof el.checkVisibility === 'function') return el.checkVisibility();
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export type Composer = HTMLElement;

export function findComposer(site: Site): Composer | null {
  for (const selector of site.composer) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (isVisible(el)) return el;
    }
  }
  return null;
}

/** The composer this element belongs to, if any. */
export function composerOf(site: Site, target: EventTarget | null): Composer | null {
  if (!(target instanceof Element)) return null;
  for (const selector of site.composer) {
    const el = target.closest<HTMLElement>(selector);
    if (el) return el;
  }
  return null;
}

export function isSendButton(site: Site, target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const button = target.closest('button');
  if (!button) return false;
  if (site.sendButton.some((s) => button.matches(s))) return true;
  // Fallback: a submit button, or one labelled "send", in the same form as the composer.
  const composer = findComposer(site);
  const form = composer?.closest('form, fieldset');
  if (!form || !form.contains(button)) return false;
  return button.type === 'submit' || SEND_LABEL.test(button.getAttribute('aria-label') ?? '');
}
