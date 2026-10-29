/**
 * A small notice in the corner of the page. It lives in a closed shadow root,
 * so the site's own scripts and styles can't read or restyle it, or find its buttons.
 */
let host: HTMLElement | null = null;
let box: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function ensure(): HTMLElement {
  if (box && host?.isConnected) return box;
  host = document.createElement('veil-notice');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .box { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; max-width: 360px;
        padding: 12px 14px; border-radius: 10px; font: 13px/1.45 system-ui, sans-serif;
        background: #1f2328; color: #f6f8fa; box-shadow: 0 6px 24px rgba(0,0,0,.25);
        opacity: 0; transform: translateY(6px); transition: opacity .15s, transform .15s; pointer-events: none; }
      .box.show { opacity: 1; transform: none; }
      .box.show.actionable { pointer-events: auto; }
      .box.error { background: #8a1c1c; }
      b { font-weight: 600; }
      button { margin-left: 8px; padding: 2px 10px; border-radius: 6px; border: 1px solid #8b949e;
        background: transparent; color: inherit; font: inherit; cursor: pointer; }
      button:hover { background: rgba(255,255,255,.12); }
      button:focus-visible { outline: 2px solid #58a6ff; outline-offset: 1px; }
    </style>
    <div class="box" role="status" aria-live="polite"></div>`;
  document.documentElement.appendChild(host);
  box = root.querySelector('.box');
  return box!;
}

export interface NoticeAction {
  label: string;
  run: () => void;
}

export function showNotice(message: string, kind: 'info' | 'error' = 'info', ms = 6000, action?: NoticeAction): void {
  const el = ensure();
  el.textContent = '';
  const title = document.createElement('b');
  title.textContent = 'Veil: ';
  el.append(title, message);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    // Keep focus in the message box: clicking the notice must not blur the editor.
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      hideNotice();
      action.run();
    });
    el.append(button);
  }
  el.classList.toggle('error', kind === 'error');
  el.classList.toggle('actionable', !!action);
  el.classList.add('show');
  clearTimeout(timer);
  timer = setTimeout(() => el.classList.remove('show'), ms);
}

export function hideNotice(): void {
  clearTimeout(timer);
  box?.classList.remove('show');
}

export function isNotice(node: Node): boolean {
  return host !== null && (node === host || host.contains(node));
}
