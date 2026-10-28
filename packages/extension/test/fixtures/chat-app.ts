/**
 * A stand-in chat app for end-to-end tests. It uses the same editors as the real sites
 * (ProseMirror for ChatGPT and Claude, Quill for Gemini), sends on Enter or on its send
 * button, records exactly what it "sent", and echoes it back as the assistant's answer.
 */
import { baseKeymap } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import { schema } from 'prosemirror-schema-basic';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import Quill from 'quill';

type Kind = 'chatgpt' | 'chatgpt-textarea' | 'claude' | 'gemini';

declare global {
  interface Window {
    __fixture: { sent: string[]; getText(): string };
  }
}

const kind = (document.documentElement.dataset.kind ?? 'chatgpt') as Kind;
const sent: string[] = [];

const main = document.createElement('main');
const messages = document.createElement('div');
messages.id = 'messages';
const form = document.createElement('form');
form.addEventListener('submit', (e) => e.preventDefault());
const wrapper = document.createElement(kind === 'claude' ? 'fieldset' : 'div');
form.append(wrapper);
main.append(messages, form);
document.body.append(main);

const button = document.createElement('button');
button.type = 'button';
button.textContent = 'Send';
if (kind === 'chatgpt') button.dataset.testid = 'send-button';
if (kind === 'claude') button.setAttribute('aria-label', 'Send message');
if (kind === 'gemini') {
  button.className = 'send-button';
  button.setAttribute('aria-label', 'Send message');
}

let getText: () => string;
let clear: () => void;

function send(): void {
  const text = getText().replace(/\n+$/, '');
  if (!text.trim()) return;
  sent.push(text);
  clear();
  const user = document.createElement('div');
  user.className = 'msg user';
  user.textContent = text;
  messages.append(user);
  setTimeout(() => {
    const answer = document.createElement('div');
    answer.className = 'msg assistant';
    const p = document.createElement('p');
    p.textContent = `You wrote: ${text}`;
    answer.append(p);
    messages.append(answer);
  }, 30);
}

if (kind === 'chatgpt-textarea') {
  // Logged-out ChatGPT as seen live in Oct 2026: a plain textarea in a form, a submit button
  // labelled in the UI language, and framework state that only changes on input events.
  const area = document.createElement('textarea');
  area.id = 'mobile-composer-prompt';
  area.setAttribute('aria-label', 'Mit ChatGPT chatten');
  button.type = 'submit';
  button.setAttribute('aria-label', 'Nachricht senden');
  wrapper.append(area, button);
  let state = '';
  area.addEventListener('input', () => (state = area.value));
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  form.addEventListener('submit', send);
  getText = () => state;
  clear = () => {
    area.value = '';
    state = '';
  };
} else if (kind === 'gemini') {
  const rich = document.createElement('rich-textarea');
  const host = document.createElement('div');
  rich.append(host);
  wrapper.append(rich, button);
  const quill = new Quill(host, {
    modules: {
      keyboard: {
        bindings: {
          send: { key: 'Enter', shiftKey: false, handler: () => (send(), false) },
        },
      },
    },
  });
  getText = () => quill.getText();
  clear = () => quill.setText('');
} else {
  const mount = document.createElement('div');
  if (kind === 'chatgpt') mount.id = 'prompt-textarea';
  wrapper.append(mount, button);
  const view = new EditorView(
    { mount },
    {
      state: EditorState.create({
        schema,
        plugins: [
          keymap({ Enter: () => (send(), true), 'Shift-Enter': baseKeymap['Enter']! }),
          keymap(baseKeymap),
        ],
      }),
    },
  );
  getText = () => view.state.doc.textBetween(0, view.state.doc.content.size, '\n');
  clear = () => view.dispatch(view.state.tr.delete(0, view.state.doc.content.size));
}

if (button.type !== 'submit') button.addEventListener('click', send);
window.__fixture = { sent, getText: () => getText() };
