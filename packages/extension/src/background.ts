import { recordAudit } from '@veil/engine';
import type { AuditLog } from '@veil/engine';
import type { TabState, VeilMessage } from './messages';

// The vault lives in chrome.storage.session: kept in memory only, never written to disk,
// and cleared when the browser closes. By default only extension pages can read it;
// this lets Veil's own content scripts read it too (page scripts never can).
const allowContentScripts = (): void => {
  chrome.storage.session
    .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
    .catch((err: unknown) => console.error('Veil: could not open session storage to content scripts', err));
};

chrome.runtime.onInstalled.addListener(allowContentScripts);
chrome.runtime.onStartup.addListener(allowContentScripts);
allowContentScripts();

/**
 * The audit log: how many values of each kind Veil hid, per day, in chrome.storage.local.
 * Counts only, never a value. Writes go through this one worker so tabs can't overwrite each other.
 */
let auditQueue: Promise<void> = Promise.resolve();
function addToAudit(counts: Record<string, number>): void {
  const findings = Object.entries(counts).flatMap(([type, n]) =>
    Array.from({ length: Math.max(0, Math.min(1000, Math.floor(n))) }, () => ({ type })),
  );
  auditQueue = auditQueue
    .then(async () => {
      const stored = await chrome.storage.local.get('audit');
      const log = recordAudit((stored.audit as AuditLog | undefined) ?? {}, findings);
      await chrome.storage.local.set({ audit: log });
    })
    .catch((err: unknown) => console.warn('Veil: could not update the audit log', err));
}

const BADGE: Record<TabState, { text: string; color: string; title: string }> = {
  ok: { text: '', color: '#1a7f37', title: 'Veil is protecting this page' },
  off: { text: 'off', color: '#6e7781', title: 'Veil is switched off on this site' },
  blind: {
    text: '!',
    color: '#bc4c00',
    title: "Veil can't find the message box on this page, so it can't check what you send. The site may have changed.",
  },
};

chrome.runtime.onMessage.addListener((message: VeilMessage, sender) => {
  if (message?.type === 'veil:audit' && message.counts && typeof message.counts === 'object') {
    addToAudit(message.counts);
  } else if (message?.type === 'veil:status' && sender.tab?.id !== undefined && message.state in BADGE) {
    const tabId = sender.tab.id;
    const badge = BADGE[message.state];
    void chrome.action.setBadgeText({ tabId, text: badge.text });
    void chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color });
    void chrome.action.setTitle({ tabId, title: badge.title });
  }
});
