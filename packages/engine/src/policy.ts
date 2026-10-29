/**
 * Rules a person or a team adds on top of the built-in detectors:
 *   disabled  kinds to leave alone, e.g. ["NAME", "IP"]
 *   allow     values that stay visible: exact text (any case), a wildcard such as "*@acme.com",
 *             or a regular expression written as "/^ACME-\d+$/i"
 *   patterns  extra things to hide, e.g. internal project codes or customer IDs
 *
 * Several configs (a team's, then a person's) merge: disabled kinds and allowed values add up,
 * patterns add up. Mistakes in a config are reported in `problems` and skipped, never thrown.
 */
import { DEFAULT_DETECTORS } from './detectors.js';
import type { DetectOptions } from './engine.js';
import { LABELS } from './describe.js';
import type { Labels } from './describe.js';
import type { Detector, EntityType, Finding } from './types.js';

export interface CustomPattern {
  /** Placeholder kind: uppercase letters and underscores, e.g. "PROJECT_CODE" gives [PROJECT_CODE_1]. */
  type: string;
  /** A JavaScript regular expression, without the slashes. */
  pattern: string;
  /** Regex flags such as "i". "g" and "d" are added as needed. */
  flags?: string;
  /** Capture group that holds the value to hide; the whole match when omitted. */
  group?: number;
  /** Words for notices: [singular, plural]. */
  label?: [string, string];
  /** Wins over overlapping findings with a lower priority. Default 75 (above email, below API keys). */
  priority?: number;
  name?: string;
}

export interface PolicyConfig {
  disabled?: string[];
  allow?: string[];
  patterns?: CustomPattern[];
}

export interface Policy {
  /** Pass straight to detect() or mask(). */
  options: Required<Pick<DetectOptions, 'detectors' | 'allow'>>;
  labels: Labels;
  disabled: ReadonlySet<string>;
  /** Config entries that were skipped, in plain words. */
  problems: string[];
}

const TYPE = /^[A-Z]+(?:_[A-Z]+)*$/;
const MAX_PATTERNS = 200;
const MAX_ALLOW = 2000;

function allowMatcher(entry: string): ((value: string) => boolean) | string {
  const re = /^\/(.+)\/([a-z]*)$/s.exec(entry);
  if (re) {
    try {
      const rx = new RegExp(re[1]!, re[2]!.replace(/[gy]/g, ''));
      return (v) => rx.test(v);
    } catch (err) {
      return `allow entry ${entry} is not a valid regular expression (${(err as Error).message})`;
    }
  }
  if (entry.includes('*')) {
    const rx = new RegExp(
      `^${entry.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`,
      'is',
    );
    return (v) => rx.test(v);
  }
  const want = entry.trim().toLowerCase();
  return (v) => v.trim().toLowerCase() === want;
}

function patternDetector(p: CustomPattern, index: number): Detector | string {
  const where = `pattern ${p.name ?? (typeof p.type === 'string' && p.type ? p.type : `#${index + 1}`)}`;
  if (typeof p.type !== 'string' || !TYPE.test(p.type)) {
    return `${where}: type must be uppercase letters and underscores, like PROJECT_CODE`;
  }
  if (typeof p.pattern !== 'string' || p.pattern.length === 0) return `${where}: pattern is empty`;
  let rx: RegExp;
  try {
    const flags = new Set([...(p.flags ?? '').replace(/[^dgimsuyv]/g, ''), 'g']);
    if (p.group !== undefined) flags.add('d');
    flags.delete('y');
    rx = new RegExp(p.pattern, [...flags].join(''));
  } catch (err) {
    return `${where}: not a valid regular expression (${(err as Error).message})`;
  }
  if (rx.test('')) return `${where}: matches empty text, which would hide nothing useful`;
  const type = p.type;
  const group = p.group;
  const name = p.name ?? `custom-${type.toLowerCase()}`;
  return {
    name,
    type,
    priority: typeof p.priority === 'number' ? p.priority : 75,
    find(text: string): Finding[] {
      const out: Finding[] = [];
      for (const m of text.matchAll(rx)) {
        const span = group === undefined ? [m.index ?? 0, (m.index ?? 0) + m[0].length] : m.indices?.[group];
        const value = group === undefined ? m[0] : m[group];
        if (!span || !value) continue;
        out.push({ type, start: span[0]!, end: span[0]! + value.length, value, detector: name });
      }
      return out;
    },
  };
}

export function compilePolicy(...configs: Array<PolicyConfig | null | undefined>): Policy {
  const problems: string[] = [];
  const disabled = new Set<string>();
  const allowFns: Array<(value: string) => boolean> = [];
  const custom: Detector[] = [];
  const labels: Record<string, readonly [string, string]> = { ...LABELS };

  for (const config of configs) {
    if (!config) continue;
    for (const t of config.disabled ?? []) if (typeof t === 'string') disabled.add(t.toUpperCase());
    for (const entry of (config.allow ?? []).slice(0, MAX_ALLOW)) {
      if (typeof entry !== 'string' || entry.trim() === '') continue;
      const m = allowMatcher(entry);
      if (typeof m === 'string') problems.push(m);
      else allowFns.push(m);
    }
    (config.patterns ?? []).slice(0, MAX_PATTERNS).forEach((p, i) => {
      const d = patternDetector(p, i);
      if (typeof d === 'string') problems.push(d);
      else {
        custom.push(d);
        if (Array.isArray(p.label) && p.label.length === 2) labels[p.type] = [String(p.label[0]), String(p.label[1])];
      }
    });
  }

  const detectors = [...DEFAULT_DETECTORS, ...custom].filter((d) => !disabled.has(d.type));
  const allow = (f: Finding): boolean => allowFns.some((fn) => fn(f.value));
  return { options: { detectors, allow }, labels, disabled, problems };
}

/** Kinds a policy can turn off, for settings screens. */
export const BUILTIN_TYPES: readonly EntityType[] = Object.keys(LABELS);
