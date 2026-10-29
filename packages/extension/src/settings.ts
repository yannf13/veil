/**
 * What Veil hides, where it runs, and what stays visible.
 *
 * Two layers, merged into one policy:
 *  - your settings, in chrome.storage.sync (follows your Chrome profile, holds no hidden values);
 *  - your organization's, in chrome.storage.managed, pushed by an admin through Chrome policy
 *    (see managed_schema.json). An admin's hidden kinds and patterns always apply, and an admin
 *    can stop people from switching Veil off.
 */
import { compilePolicy } from '@veil/engine';
import type { CustomPattern, Policy } from '@veil/engine';

export interface UserSettings {
  /** Sites where you switched Veil off, by hostname. */
  off: string[];
  /** Kinds you don't want hidden, e.g. ["NAME"]. */
  disabled: string[];
  /** Values that stay visible. */
  allow: string[];
  patterns: CustomPattern[];
}

export interface ManagedSettings {
  disabled?: string[];
  allow?: string[];
  patterns?: CustomPattern[];
  /** false: people can't switch Veil off on a site or turn kinds off. */
  allowTurningOff?: boolean;
}

export interface Settings {
  user: UserSettings;
  managed: ManagedSettings | null;
  policy: Policy;
  /** Whether Veil runs on this host. */
  isOn(host: string): boolean;
  canTurnOff: boolean;
}

export const EMPTY_USER: UserSettings = { off: [], disabled: [], allow: [], patterns: [] };
const USER_KEY = 'settings';

const asList = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function normalizeUser(raw: unknown): UserSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<UserSettings>;
  return {
    off: asList<string>(r.off).filter((s) => typeof s === 'string'),
    disabled: asList<string>(r.disabled).filter((s) => typeof s === 'string'),
    allow: asList<string>(r.allow).filter((s) => typeof s === 'string'),
    patterns: asList<CustomPattern>(r.patterns).filter((p) => p && typeof p === 'object'),
  };
}

/**
 * With no policy installed, Chromium can leave chrome.storage.managed.get unanswered forever
 * (seen with the Chromium build Playwright 1.63 ships), so it gets a deadline. A policy is local
 * and answers in milliseconds; a policy change later arrives through onSettingsChange.
 */
async function readManaged(): Promise<ManagedSettings | null> {
  try {
    const m = await Promise.race([
      chrome.storage.managed.get(null) as Promise<ManagedSettings>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 300)),
    ]);
    return m && Object.keys(m).length > 0 ? m : null;
  } catch {
    return null; // managed storage unavailable
  }
}

async function readUser(): Promise<UserSettings> {
  try {
    const stored = await chrome.storage.sync.get(USER_KEY);
    return normalizeUser(stored[USER_KEY]);
  } catch {
    return { ...EMPTY_USER };
  }
}

export function combine(user: UserSettings, managed: ManagedSettings | null): Settings {
  const canTurnOff = managed?.allowTurningOff !== false;
  // When an admin locks Veil on, your "off" choices are ignored; your extra allow entries and
  // patterns still apply, since they can only make Veil hide more or let you see your own text.
  const policy = compilePolicy(
    managed && { disabled: managed.disabled, allow: managed.allow, patterns: managed.patterns },
    { disabled: canTurnOff ? user.disabled : [], allow: user.allow, patterns: user.patterns },
  );
  const off = new Set(canTurnOff ? user.off : []);
  return { user, managed, policy, canTurnOff, isOn: (host) => !off.has(host.replace(/^www\./, '')) };
}

/** Your organization's settings change rarely: read once, again only when Chrome says they changed. */
let managedCache: Promise<ManagedSettings | null> | null = null;

export async function loadSettings(): Promise<Settings> {
  managedCache ??= readManaged();
  const [user, managed] = await Promise.all([readUser(), managedCache]);
  return combine(user, managed);
}

export async function saveUserSettings(user: UserSettings): Promise<void> {
  await chrome.storage.sync.set({ [USER_KEY]: normalizeUser(user) });
}

/** Calls back with fresh settings whenever yours or your organization's change. */
export function onSettingsChange(callback: (settings: Settings) => void): void {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'managed') managedCache = null;
      if ((area === 'sync' && USER_KEY in changes) || area === 'managed') void loadSettings().then(callback);
    });
  } catch {
    // storage unavailable: keep the defaults
  }
}
