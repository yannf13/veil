/**
 * Veil for Claude Code: one script, run by Claude Code's hooks.
 *
 *   session-start   Tells the agent what placeholders are and how to work with them. Without this,
 *                   real Claude Code runs showed the agent taking placeholders for mistakes and
 *                   dumping file bytes (od -c) to read the real value back. Also clears vaults that
 *                   crashed sessions left behind, and reports mistakes in your Veil config.
 *   user-prompt     A typed prompt with secrets in it is blocked: hooks can't rewrite a prompt
 *                   (checked in Claude Code 2.1.312), so Veil shows the masked version to send instead.
 *                   Also answers "veil show", "veil stats", "veil forget" and "veil help" without the model.
 *   prompt-expansion  The same for /veil:show, /veil:stats, /veil:forget and /veil:help.
 *   post-tool       What a tool returns (file contents, command output, web pages) is masked before
 *                   the agent sees it. Only string values change, so each tool's output keeps its
 *                   shape, which Claude Code requires. Output that shows a hidden value in another
 *                   form (hex dump, base64, one character at a time) is withheld.
 *   pre-tool        Placeholders in what the agent writes or runs are swapped back for the real values
 *                   just before the tool runs. Commands that would dump the bytes of a file holding
 *                   hidden values, or edit such a file in place, are refused with the reason.
 *   message-display The agent's replies show real values on your screen; the model and the stored
 *                   conversation keep the placeholders.
 *
 * The vault (placeholder <-> value) is one file per session in ~/.veil/vaults, readable only by you.
 * It is kept after the session so a resumed conversation still works, and deleted after 30 days
 * without use, or at once with "veil forget".
 */
import { auditTotals, compilePolicy, describeCounts, describeFindings, mask, recordAudit, restore, Vault } from '@veil/engine';
import type { AuditLog, Finding, Policy, PolicyConfig, VaultEntry } from '@veil/engine';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { encodedLeak } from './leaks.js';
import { dumpsBytes, filesChangedInPlace, filesHolding, filesIn } from './shell.js';

interface HookInput {
  session_id?: string;
  cwd?: string;
  prompt?: string;
  command_name?: string;
  command_args?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  delta?: string;
}

export type Mode =
  | 'session-start'
  | 'user-prompt'
  | 'prompt-expansion'
  | 'pre-tool'
  | 'post-tool'
  | 'message-display'
  | 'session-end';
const MODES: readonly Mode[] = ['session-start', 'user-prompt', 'prompt-expansion', 'pre-tool', 'post-tool', 'message-display', 'session-end'];

/** What the agent is told at the start of every session. */
export const AGENT_GUIDE = [
  'Veil is active in this session. It hides secrets and personal data from you: in tool results they appear as placeholders such as [EMAIL_1] or [API_KEY_2]. The user installed Veil on purpose, and sees the real values on their screen.',
  '- Treat each placeholder as the value itself and use it as-is in files you write, commands you run and replies to the user. Veil puts the real value back just before a file is written or a command runs, then hides it again in the output. A placeholder is never a mistake to fix.',
  "- Don't try to recover hidden values (no hex or byte dumps, od, xxd, base64, character-by-character reads, or similar), and don't ask the user for them. Veil refuses such commands on files that hold hidden values and withholds output that shows them in another form.",
  "- To change a file that shows placeholders, rewrite the whole file with the Write tool, keeping the placeholders. Don't use Edit on text that contains a placeholder (the file on disk holds the real value, so Edit can't match it), and don't change such files with shell commands such as sed -i or > redirects: Claude Code then shows you the changed lines without Veil's masking, so Veil refuses those commands.",
].join('\n');

/** Keys whose values are never masked or restored: they hold paths, types and binary data, not text. */
const SKIP_KEYS = new Set(['type', 'filePath', 'file_path', 'path', 'notebook_path', 'base64', 'media_type', 'mimeType']);

/**
 * A vault outlives its session so the conversation can be resumed (claude --resume) with its
 * placeholders still working. Vaults unused for this long are deleted.
 */
const STALE_MS = 30 * 24 * 3600_000;

// ---------------------------------------------------------------------------
// Files: vault, config, audit log
// ---------------------------------------------------------------------------

export const veilHome = (): string => process.env.VEIL_HOME ?? join(homedir(), '.veil');
const vaultDir = (): string => process.env.VEIL_VAULT_DIR ?? join(veilHome(), 'vaults');

export function vaultPath(sessionId: string): string {
  return join(vaultDir(), `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_') || 'default'}.json`);
}

function loadVault(path: string): Vault {
  try {
    return Vault.fromJSON(JSON.parse(readFileSync(path, 'utf8')) as VaultEntry[]);
  } catch {
    return new Vault();
  }
}

/** Writes a private file atomically, so parallel hooks never read half a file. */
function writePrivate(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

const saveVault = (path: string, vault: Vault): void => writePrivate(path, JSON.stringify(vault.toJSON()));

interface LoadedPolicy {
  policy: Policy;
  /** Config problems, each with the file it came from. */
  problems: string[];
  /** false when any config says "showRealValues": false: replies then show placeholders on screen too. */
  showRealValues: boolean;
}

type VeilConfig = PolicyConfig & { showRealValues?: boolean };

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

const auditPath = (): string => join(veilHome(), 'audit.json');

/** Adds counts (never values) to ~/.veil/audit.json. Best effort: a lost count is not worth failing a hook. */
function audit(findings: readonly Finding[]): void {
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
function clearStaleVaults(now = Date.now()): void {
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
type VeilCommand = 'show' | 'stats' | 'forget' | 'help';

function veilCommand(prompt: string): VeilCommand | null {
  const m = /^\s*\/?veil[\s:]+(show|values|stats|forget|help)\s*$/i.exec(prompt);
  if (!m) return /^\s*\/?veil\s*$/i.test(prompt) ? 'help' : null;
  const word = m[1]!.toLowerCase();
  return word === 'values' ? 'show' : (word as VeilCommand);
}

function answer(command: VeilCommand, sessionId: string, cwd: string | undefined): string {
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

/** Blocks a prompt and shows `text` to you instead of sending anything to the model. */
const showInstead = (text: string, event: 'UserPromptSubmit' | 'UserPromptExpansion') => ({
  decision: 'block',
  reason: text,
  hookSpecificOutput: { hookEventName: event, suppressOriginalPrompt: true },
  suppressOutput: true,
});

const deny = (reason: string) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

// ---------------------------------------------------------------------------
// The hooks
// ---------------------------------------------------------------------------

/** Runs one hook. Returns the JSON to print, or null to print nothing (no change). */
export function run(mode: Mode, input: HookInput): object | null {
  const sessionId = input.session_id ?? 'default';
  const path = vaultPath(sessionId);

  switch (mode) {
    case 'session-start': {
      clearStaleVaults();
      if (existsSync(path)) utimesSync(path, new Date(), new Date()); // a resumed session keeps its vault
      const { problems } = loadPolicy(input.cwd);
      return {
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: AGENT_GUIDE },
        ...(problems.length > 0 && {
          systemMessage: `Veil skipped some of your rules:\n${problems.map((p) => `- ${p}`).join('\n')}`,
        }),
      };
    }

    case 'user-prompt': {
      const prompt = input.prompt ?? '';
      const command = veilCommand(prompt);
      if (command) return showInstead(answer(command, sessionId, input.cwd), 'UserPromptSubmit');
      const { policy } = loadPolicy(input.cwd);
      const vault = loadVault(path);
      const { text, findings } = mask(prompt, { vault, ...policy.options });
      if (findings.length === 0) return null;
      saveVault(path, vault);
      audit(findings);
      return showInstead(
        `Veil stopped this prompt: it contains ${describeFindings(findings, policy.labels)}. Nothing was sent.\n` +
          `Send this version instead; Veil puts the real values back whenever the agent writes a file or runs a command:\n\n${text}`,
        'UserPromptSubmit',
      );
    }

    case 'prompt-expansion': {
      const name = (input.command_name ?? '').replace(/^\//, '');
      const m = /^veil:(show|stats|forget|help)$/.exec(name);
      return m ? showInstead(answer(m[1] as VeilCommand, sessionId, input.cwd), 'UserPromptExpansion') : null;
    }

    case 'post-tool': {
      if (input.tool_response === undefined) return null;
      const { policy } = loadPolicy(input.cwd);
      const vault = loadVault(path);
      const before = vault.size;
      const hidden: Finding[] = [];
      const masked = mapStrings(input.tool_response, (s) => {
        const result = mask(s, { vault, ...policy.options });
        hidden.push(...result.findings);
        // Checked on the raw text: an encoded value can look random enough to be masked on its own,
        // and withholding says more than a stray [SECRET_n].
        const leak = encodedLeak(s, vault.entries().map((e) => e.value));
        if (!leak) return result.text;
        return `[Veil withheld this output: it shows a hidden value in another form (${leak}). Work with the placeholders as they are.]`;
      });
      if (masked === input.tool_response) return null;
      if (vault.size !== before) saveVault(path, vault);
      audit(hidden);
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: masked }, suppressOutput: true };
    }

    case 'pre-tool': {
      if (!existsSync(path)) return null;
      const vault = loadVault(path);
      if (vault.size === 0) return null;
      const restored = mapStrings(input.tool_input, (s) => restore(s, vault)) as Record<string, unknown> | undefined;

      const command = typeof restored?.command === 'string' ? restored.command : null;
      if (command !== null) {
        const cwd = input.cwd ?? process.cwd();
        const values = vault.entries().map((e) => e.value);
        const shown = (files: string[]) => files.map((f) => relative(cwd, f) || f).join(', ');
        const holding = filesHolding(filesIn(command, cwd), values);
        if (holding.length > 0 && dumpsBytes(command)) {
          return deny(
            `Veil: ${shown(holding)} holds values hidden from you, and this command would show them in another form. ` +
              'Treat the placeholders as the values. If the user needs the raw bytes, they can run the command themselves.',
          );
        }
        const edited = filesHolding(filesChangedInPlace(command, cwd), values);
        if (edited.length > 0) {
          return deny(
            `Veil: ${shown(edited)} holds values hidden from you. Change it with the Write tool, keeping the placeholders: ` +
              "after a shell command edits a file, Claude Code shows you the changed lines without Veil's masking.",
          );
        }
      }

      if (restored === input.tool_input) return null;
      // This output holds real values. Claude Code never sends a PreToolUse hook's output to the model
      // (checked in 2.1.312), but logs it in the local transcript; suppressOutput hides it from the on-screen view.
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: restored }, suppressOutput: true };
    }

    case 'message-display': {
      const delta = input.delta ?? '';
      if (!delta.includes('[') || !existsSync(path) || !loadPolicy(input.cwd).showRealValues) return null;
      const shown = restore(delta, loadVault(path));
      if (shown === delta) return null;
      // Display only: Claude Code keeps the stored message, and what the model sees, unchanged.
      return { hookSpecificOutput: { hookEventName: 'MessageDisplay', displayContent: shown }, suppressOutput: true };
    }

    case 'session-end':
      // The vault stays, so the conversation can be resumed. "veil forget" deletes it now.
      return null;
  }
}

function main(): void {
  const mode = process.argv[2] as Mode;
  if (!MODES.includes(mode)) {
    process.stderr.write(`veil: unknown hook "${mode}"\n`);
    process.exit(1);
  }
  let input: HookInput = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}') as HookInput;
  } catch {
    process.stderr.write('veil: could not read the hook input\n');
    process.exit(1);
  }
  try {
    const out = run(mode, input);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err) {
    // Fail loudly rather than silently: Claude Code shows this message.
    process.stderr.write(`veil: ${mode} hook failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && /veil-hook\.(m?js|ts)$/.test(process.argv[1])) main();
