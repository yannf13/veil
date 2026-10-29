/**
 * What every Veil agent integration shares: the per-session vault, the rules from config files,
 * the values-free audit log, masking of tool output, the refusal of commands that would expose
 * hidden values, and the "veil show/stats/forget/help" answers.
 */
import { auditTotals, compilePolicy, describeCounts, mask, recordAudit, Vault } from '@veil/engine';
import type { AuditLog, Finding, Policy, PolicyConfig, VaultEntry } from '@veil/engine';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { encodedLeak } from './leaks.js';
import { dumpsBytes, filesChangedInPlace, filesHolding, filesIn } from './shell.js';

/** Keys whose values are never masked or restored: they hold paths, types and binary data, not text. */
export const SKIP_KEYS = new Set(['type', 'filePath', 'file_path', 'path', 'notebook_path', 'base64', 'media_type', 'mimeType']);

/**
 * A vault outlives its session so the conversation can be resumed (claude --resume) with its
 * placeholders still working. Vaults unused for this long are deleted.
 */
export const STALE_MS = 30 * 24 * 3600_000;

// ---------------------------------------------------------------------------
// Files: vault, config, audit log
// ---------------------------------------------------------------------------

export const veilHome = (): string => process.env.VEIL_HOME ?? join(homedir(), '.veil');
export const vaultDir = (): string => process.env.VEIL_VAULT_DIR ?? join(veilHome(), 'vaults');

export function vaultPath(sessionId: string): string {
  return join(vaultDir(), `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_') || 'default'}.json`);
}

export function loadVault(path: string): Vault {
  try {
    return Vault.fromJSON(JSON.parse(readFileSync(path, 'utf8')) as VaultEntry[]);
  } catch {
    return new Vault();
  }
}

/** Writes a private file atomically, so parallel hooks never read half a file. */
export function writePrivate(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export const saveVault = (path: string, vault: Vault): void => writePrivate(path, JSON.stringify(vault.toJSON()));

export interface LoadedPolicy {
  policy: Policy;
  /** Config problems, each with the file it came from. */
  problems: string[];
  /** false when any config says "showRealValues": false: replies then show placeholders on screen too. */
  showRealValues: boolean;
}

export type VeilConfig = PolicyConfig & { showRealValues?: boolean };

function readConfig(path: string, problems: string[]): VeilConfig | null {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a JSON object');
    return data as VeilConfig;
  } catch (err) {
    problems.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** The nearest .veil.json from `cwd` up to the repository root: a team's shared rules, committed with the code. */
function teamConfigPath(cwd: string | undefined): string | null {
  if (!cwd) return null;
  for (let dir = cwd; ; dir = dirname(dir)) {
    const candidate = join(dir, '.veil.json');
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) return null;
  }
}

/**
 * Rules from three places, all optional, all in the same format ({ disabled, allow, patterns }):
 * the machine's (/etc/veil/config.json, or VEIL_MANAGED_CONFIG), the project's (.veil.json) and yours
 * (~/.veil/config.json). They add up: any of them can hide more, allow a value, or turn a kind off.
 */
export function loadPolicy(cwd: string | undefined): LoadedPolicy {
  const problems: string[] = [];
  const paths = [
    process.env.VEIL_MANAGED_CONFIG ?? '/etc/veil/config.json',
    teamConfigPath(cwd),
    join(veilHome(), 'config.json'),
  ].filter((p): p is string => !!p);
  const configs = paths.map((p) => ({ path: p, config: readConfig(p, problems) }));
  const policy = compilePolicy(...configs.map((c) => c.config));
  // Say which file a rule problem came from.
  for (const { path, config } of configs) {
    if (config) for (const p of compilePolicy(config).problems) problems.push(`${path}: ${p}`);
  }
  const showRealValues = !configs.some((c) => c.config?.showRealValues === false);
  return { policy, problems, showRealValues };
}

export const auditPath = (): string => join(veilHome(), 'audit.json');

/** Adds counts (never values) to ~/.veil/audit.json. Best effort: a lost count is not worth failing a hook. */
export function audit(findings: readonly Finding[]): void {
  if (findings.length === 0) return;
  try {
    let log: AuditLog = {};
    try {
      log = JSON.parse(readFileSync(auditPath(), 'utf8')) as AuditLog;
    } catch {
      // first entry
    }
    writePrivate(auditPath(), JSON.stringify(recordAudit(log, findings)));
  } catch {
    // read-only home, full disk: keep working
  }
}

/** Deletes vaults no session has used for a month. */
export function clearStaleVaults(now = Date.now()): void {
  try {
    for (const name of readdirSync(vaultDir())) {
      if (!name.endsWith('.json')) continue;
      const path = join(vaultDir(), name);
      if (now - statSync(path).mtimeMs > STALE_MS) rmSync(path, { force: true });
    }
  } catch {
    // no vault folder yet
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Applies `fn` to every string in a JSON value, keeping its shape. Returns the same object if nothing changed. */
export function mapStrings(value: unknown, fn: (s: string) => string, key = ''): unknown {
  if (typeof value === 'string') return SKIP_KEYS.has(key) ? value : fn(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const m = mapStrings(v, fn, key);
      if (m !== v) changed = true;
      return m;
    });
    return changed ? out : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const m = mapStrings(v, fn, k);
      if (m !== v) changed = true;
      out[k] = m;
    }
    return changed ? out : value;
  }
  return value;
}

/** Commands you type instead of a prompt. Answered by Veil; the model never sees them. */
export type VeilCommand = 'show' | 'stats' | 'forget' | 'help';

export function veilCommand(prompt: string): VeilCommand | null {
  const m = /^\s*\/?veil[\s:]+(show|values|stats|forget|help)\s*$/i.exec(prompt);
  if (!m) return /^\s*\/?veil\s*$/i.test(prompt) ? 'help' : null;
  const word = m[1]!.toLowerCase();
  return word === 'values' ? 'show' : (word as VeilCommand);
}

export function answer(command: VeilCommand, sessionId: string, cwd: string | undefined): string {
  if (command === 'show') {
    const entries = loadVault(vaultPath(sessionId)).entries();
    if (entries.length === 0) return 'Veil: nothing is hidden in this session yet.';
    const width = Math.max(...entries.map((e) => e.placeholder.length));
    return [
      `Veil: ${entries.length} hidden value${entries.length === 1 ? '' : 's'} in this session. Only you see this list; the model doesn't.`,
      ...entries.map((e) => `  ${e.placeholder.padEnd(width)}  ${e.value.replace(/\s*\n\s*/g, ' ⏎ ')}`),
    ].join('\n');
  }
  if (command === 'forget') {
    const path = vaultPath(sessionId);
    const n = loadVault(path).size;
    rmSync(path, { force: true });
    return n === 0
      ? 'Veil: nothing was hidden in this session.'
      : `Veil: deleted the ${n} hidden value${n === 1 ? '' : 's'} of this session. Placeholders already in this conversation now stay placeholders: the agent can't write their real values anymore.`;
  }
  if (command === 'stats') {
    let log: AuditLog = {};
    try {
      log = JSON.parse(readFileSync(auditPath(), 'utf8')) as AuditLog;
    } catch {
      // nothing recorded
    }
    const { policy } = loadPolicy(cwd);
    const week = describeCounts(auditTotals(log, 7), policy.labels);
    const month = describeCounts(auditTotals(log, 30), policy.labels);
    return [
      'Veil: what it kept from the model (counts only, no values are logged).',
      `  Last 7 days:  ${week || 'nothing'}`,
      `  Last 30 days: ${month || 'nothing'}`,
      `  Log: ${auditPath()}`,
    ].join('\n');
  }
  const { problems } = loadPolicy(cwd);
  return [
    'Veil hides secrets and personal data from the model in this session.',
    '  veil show   list the hidden values and their placeholders (only you see it)',
    '  veil stats  what Veil hid in the last 7 and 30 days',
    "  veil forget delete this session's hidden values now (otherwise kept 30 days, so you can resume)",
    `  Rules: ${join(veilHome(), 'config.json')} (yours), .veil.json in the project (your team's)`,
    '         { "disabled": ["NAME"], "allow": ["*@yourcompany.com"], "patterns": [{ "type": "TICKET", "pattern": "SEC-\\\\d+" }] }',
    ...(problems.length ? ['  Problems in your rules:', ...problems.map((p) => `    ${p}`)] : []),
  ].join('\n');
}

/** Keeps a resumed session's vault from being cleared as stale. */
export function touchVault(path: string): void {
  if (existsSync(path)) utimesSync(path, new Date(), new Date());
}

export interface MaskedOutput {
  /** The output with every hidden value replaced, same shape as the input. Same object if nothing changed. */
  masked: unknown;
  findings: Finding[];
  /** True when some string showed a hidden value in another form and was withheld. */
  withheld: boolean;
}

/** Masks every string in a tool's output and withholds strings that show a hidden value in another form. */
export function maskOutput(output: unknown, vault: Vault, policy: Policy): MaskedOutput {
  const findings: Finding[] = [];
  let withheld = false;
  const masked = mapStrings(output, (s) => {
    const result = mask(s, { vault, ...policy.options });
    findings.push(...result.findings);
    // Checked on the raw text: an encoded value can look random enough to be masked on its own,
    // and withholding says more than a stray [SECRET_n].
    const leak = encodedLeak(s, vault.entries().map((e) => e.value));
    if (!leak) return result.text;
    withheld = true;
    return `[Veil withheld this output: it shows a hidden value in another form (${leak}). Work with the placeholders as they are.]`;
  });
  return { masked, findings, withheld };
}

/**
 * Why a shell command must not run, or null. Refused: dumping the bytes of a file that holds hidden
 * values, and editing such a file in place (agents are then shown the changed lines unmasked).
 * `writeTool` names the agent's own file-writing tool, for the advice.
 */
export function refusalFor(command: string, cwd: string, vault: Vault, writeTool = 'Write'): string | null {
  if (vault.size === 0) return null;
  const values = vault.entries().map((e) => e.value);
  const shown = (files: string[]) => files.map((f) => relative(cwd, f) || f).join(', ');
  const holding = filesHolding(filesIn(command, cwd), values);
  if (holding.length > 0 && dumpsBytes(command)) {
    return (
      `Veil: ${shown(holding)} holds values hidden from you, and this command would show them in another form. ` +
      'Treat the placeholders as the values. If the user needs the raw bytes, they can run the command themselves.'
    );
  }
  const edited = filesHolding(filesChangedInPlace(command, cwd), values);
  if (edited.length > 0) {
    return (
      `Veil: ${shown(edited)} holds values hidden from you. Change it with the ${writeTool} tool, keeping the placeholders: ` +
      "after a shell command edits a file, you are shown the changed lines without Veil's masking."
    );
  }
  return null;
}
