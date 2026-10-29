/**
 * The toolbar popup: is Veil protecting this page, what it hid lately (counts only),
 * and your rules. Your organization's rules, if any, show as locked.
 */
import { auditTotals, BUILTIN_TYPES, compilePolicy, describeCounts, LABELS } from '@veil/engine';
import type { AuditLog } from '@veil/engine';
import type { TabInfo } from './messages';
import { formatPatterns, parsePatterns } from './popup-patterns';
import { loadSettings, saveUserSettings } from './settings';
import type { Settings, UserSettings } from './settings';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let settings: Settings;

async function activeTabInfo(): Promise<TabInfo | null> {
  // The page can be opened directly with #tab=<id> (tests, or a pinned tab); otherwise it's the active tab.
  const fromHash = Number(/tab=(\d+)/.exec(location.hash)?.[1]);
  let tabId: number | undefined = Number.isFinite(fromHash) && fromHash > 0 ? fromHash : undefined;
  if (tabId === undefined) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  }
  if (tabId === undefined) return null;
  try {
    return ((await chrome.tabs.sendMessage(tabId, { type: 'veil:tab-info' })) as TabInfo | undefined) ?? null;
  } catch {
    return null; // not a page Veil runs on
  }
}

function renderSite(info: TabInfo | null): void {
  const line = $('site-line');
  const dot = $('dot');
  const warn = $('site-warn');
  const sw = $('switch');
  const input = $<HTMLInputElement>('site-on');
  if (!info) {
    line.textContent = 'Veil protects ChatGPT, Claude and Gemini. Open one of them to see it at work.';
    dot.className = 'dot';
    sw.hidden = true;
    warn.hidden = true;
    return;
  }
  const on = settings.isOn(info.host);
  sw.hidden = false;
  input.checked = on;
  input.disabled = !settings.canTurnOff;
  input.onchange = () => void setSiteOn(info.host, input.checked);
  dot.className = `dot ${on ? (info.state === 'blind' ? 'blind' : 'ok') : ''}`;
  line.textContent = on
    ? `On for ${info.site}${info.hidden > 0 ? ` · ${info.hidden} hidden value${info.hidden === 1 ? '' : 's'} on this page` : ''}`
    : `Off for ${info.site}. What you send there isn't checked.`;
  warn.hidden = !(on && info.state === 'blind');
  warn.textContent = "Veil can't find the message box on this page, so it can't check what you send. The site may have changed its layout: update Veil, or check your messages yourself.";
}

async function setSiteOn(host: string, on: boolean): Promise<void> {
  const h = host.replace(/^www\./, '');
  const off = new Set(settings.user.off);
  if (on) off.delete(h);
  else off.add(h);
  await save({ ...settings.user, off: [...off] });
  renderSite(await activeTabInfo());
}

function renderKinds(): void {
  const box = $('kinds');
  box.textContent = '';
  const adminOff = new Set((settings.managed?.disabled ?? []).map((t) => t.toUpperCase()));
  for (const type of BUILTIN_TYPES) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = type;
    input.checked = !settings.policy.disabled.has(type);
    const locked = adminOff.has(type) || !settings.canTurnOff;
    input.disabled = locked;
    if (locked) label.title = 'Set by your organization';
    input.onchange = () => {
      const disabled = new Set(settings.user.disabled.map((t) => t.toUpperCase()));
      if (input.checked) disabled.delete(type);
      else disabled.add(type);
      void save({ ...settings.user, disabled: [...disabled] });
    };
    const text = document.createElement('span');
    const words = LABELS[type as keyof typeof LABELS]?.[1] ?? type;
    text.textContent = words[0]!.toUpperCase() + words.slice(1);
    label.append(input, text);
    box.append(label);
  }
}


function renderRules(): void {
  $<HTMLTextAreaElement>('allow').value = settings.user.allow.join('\n');
  $<HTMLTextAreaElement>('patterns').value = formatPatterns(settings.user.patterns);
}

function showProblems(problems: string[]): void {
  const list = $('problems');
  list.textContent = '';
  for (const p of problems) {
    const li = document.createElement('li');
    li.textContent = p;
    list.append(li);
  }
  list.hidden = problems.length === 0;
}

async function saveRules(): Promise<void> {
  const allow = $<HTMLTextAreaElement>('allow').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const patterns = parsePatterns($<HTMLTextAreaElement>('patterns').value);
  const { problems } = compilePolicy({ allow, patterns });
  showProblems(problems);
  if (problems.length > 0) {
    $('saved').textContent = '';
    return;
  }
  await save({ ...settings.user, allow, patterns });
  $('saved').textContent = 'Saved';
  setTimeout(() => ($('saved').textContent = ''), 2000);
}

async function save(user: UserSettings): Promise<void> {
  await saveUserSettings(user);
  settings = await loadSettings();
  renderKinds();
}

async function renderAudit(): Promise<void> {
  const stored = await chrome.storage.local.get('audit');
  const totals = auditTotals((stored.audit as AuditLog | undefined) ?? {}, 30);
  // Most first; ties in the order the kinds are listed below.
  const rank = (t: string): number => (BUILTIN_TYPES.indexOf(t) + 1 || BUILTIN_TYPES.length + 1);
  const sorted = Object.fromEntries(Object.entries(totals).sort(([a, x], [b, y]) => y - x || rank(a) - rank(b)));
  const text = describeCounts(sorted, settings.policy.labels);
  $('audit').textContent = text ? `${text[0]!.toUpperCase()}${text.slice(1)}.` : 'Nothing yet.';
}

async function main(): Promise<void> {
  settings = await loadSettings();
  if (settings.managed) {
    $('footer').textContent =
      'Some rules are set by your organization. Everything stays on this device; Veil never sends your text anywhere.';
  }
  renderKinds();
  renderRules();
  $('save').onclick = () => void saveRules();
  await Promise.all([renderAudit(), activeTabInfo().then(renderSite)]);
}

void main();
