import { DEFAULT_DETECTORS } from './detectors.js';
import type { Detector, EntityType, Finding } from './types.js';

export interface DetectOptions {
  /** Rule set to use; defaults to DEFAULT_DETECTORS. */
  detectors?: readonly Detector[];
  /** Only report these kinds; defaults to all. */
  types?: readonly EntityType[];
}

/**
 * Finds sensitive values in `text`. Overlapping findings are settled by detector priority,
 * then by length, so a whole API key wins over a high-entropy fragment of it.
 * Returns non-overlapping findings sorted by position.
 */
export function detect(text: string, options: DetectOptions = {}): Finding[] {
  const detectors = (options.detectors ?? DEFAULT_DETECTORS).filter(
    (d) => !options.types || options.types.includes(d.type),
  );
  const candidates = detectors.flatMap((d) => d.find(text).map((f) => ({ f, priority: d.priority })));
  candidates.sort(
    (a, b) =>
      b.priority - a.priority ||
      b.f.end - b.f.start - (a.f.end - a.f.start) ||
      a.f.start - b.f.start,
  );
  const chosen: Finding[] = [];
  for (const { f } of candidates) {
    if (!chosen.some((c) => f.start < c.end && c.start < f.end)) chosen.push(f);
  }
  return chosen.sort((a, b) => a.start - b.start);
}

export interface VaultEntry {
  placeholder: string;
  type: EntityType;
  value: string;
}

/**
 * Maps real values to placeholders and back. Keep one vault per conversation so the same
 * value always gets the same placeholder and earlier answers can still be restored.
 * The vault holds the real values: it must never leave the device. Encryption at rest comes next.
 */
export class Vault {
  private readonly byKey = new Map<string, VaultEntry>();
  private readonly byPlaceholder = new Map<string, VaultEntry>();
  private readonly counters = new Map<EntityType, number>();

  get size(): number {
    return this.byPlaceholder.size;
  }

  placeholderFor(type: EntityType, value: string): string {
    const key = `${type}\u0000${value}`;
    const existing = this.byKey.get(key);
    if (existing) return existing.placeholder;
    const n = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, n);
    const entry: VaultEntry = { placeholder: `[${type}_${n}]`, type, value };
    this.byKey.set(key, entry);
    this.byPlaceholder.set(entry.placeholder, entry);
    return entry.placeholder;
  }

  valueOf(placeholder: string): string | undefined {
    return this.byPlaceholder.get(placeholder)?.value;
  }

  entries(): VaultEntry[] {
    return [...this.byPlaceholder.values()];
  }

  toJSON(): VaultEntry[] {
    return this.entries();
  }

  static fromJSON(entries: readonly VaultEntry[]): Vault {
    const vault = new Vault();
    for (const e of entries) {
      const key = `${e.type}\u0000${e.value}`;
      vault.byKey.set(key, e);
      vault.byPlaceholder.set(e.placeholder, e);
      const n = Number(/_(\d+)\]$/.exec(e.placeholder)?.[1] ?? 0);
      vault.counters.set(e.type, Math.max(vault.counters.get(e.type) ?? 0, n));
    }
    return vault;
  }
}

export interface MaskOptions extends DetectOptions {
  /** Reuse a conversation's vault so placeholders stay stable across messages. */
  vault?: Vault;
}

export interface MaskResult {
  /** The text with every finding replaced by its placeholder. Safe to send. */
  text: string;
  findings: Finding[];
  vault: Vault;
}

export function mask(text: string, options: MaskOptions = {}): MaskResult {
  const vault = options.vault ?? new Vault();
  const findings = detect(text, options);
  let out = '';
  let cursor = 0;
  for (const f of findings) {
    out += text.slice(cursor, f.start) + vault.placeholderFor(f.type, f.value);
    cursor = f.end;
  }
  out += text.slice(cursor);
  return { text: out, findings, vault };
}

/**
 * Matches [EMAIL_1] and the markdown-escaped forms AI answers often contain,
 * such as \[EMAIL\_1\] or [API\_KEY\_2].
 */
const PLACEHOLDER = /\\?\[([A-Z]+(?:\\?_[A-Z]+)*)\\?_(\d+)\\?\]/g;

/** Puts the real values back. Placeholders the vault doesn't know are left untouched. */
export function restore(text: string, vault: Vault): string {
  return text.replace(PLACEHOLDER, (match, type: string, n: string) => {
    const value = vault.valueOf(`[${type.replace(/\\/g, '')}_${n}]`);
    return value ?? match;
  });
}
