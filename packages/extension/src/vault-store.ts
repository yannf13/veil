import { Vault } from '@veil/engine';
import type { VaultEntry } from '@veil/engine';

/**
 * One vault per site, shared by all its tabs, in chrome.storage.session (memory only,
 * cleared when the browser closes). Sharing per site means a value keeps its placeholder
 * across conversations, and no two values on a site ever share a placeholder.
 */
const keyFor = (host: string): string => `vault:${host}`;

export async function loadVault(host: string): Promise<Vault> {
  try {
    const key = keyFor(host);
    const stored = await chrome.storage.session.get(key);
    const entries = stored[key] as VaultEntry[] | undefined;
    return entries ? Vault.fromJSON(entries) : new Vault();
  } catch (err) {
    console.warn('Veil: session storage unavailable, using a tab-only vault', err);
    return new Vault();
  }
}

export async function saveVault(host: string, vault: Vault): Promise<void> {
  try {
    await chrome.storage.session.set({ [keyFor(host)]: vault.toJSON() });
  } catch (err) {
    console.warn('Veil: could not save the vault; restores will work in this tab only', err);
  }
}

/** Calls back with the new vault whenever another tab of the same site changes it. */
export function onVaultChange(host: string, callback: (vault: Vault) => void): void {
  try {
    chrome.storage.session.onChanged.addListener((changes) => {
      const change = changes[keyFor(host)];
      if (change?.newValue) callback(Vault.fromJSON(change.newValue as VaultEntry[]));
    });
  } catch {
    // Storage unavailable: the tab-only vault still works.
  }
}
