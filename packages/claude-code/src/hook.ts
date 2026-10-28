/**
 * Veil for Claude Code: one script, run by Claude Code's hooks.
 *
 *   user-prompt  A typed prompt with secrets in it is blocked: hooks can't rewrite a prompt
 *                (checked in Claude Code 2.1.312), so Veil shows the masked version to send instead.
 *   post-tool    What a tool returns (file contents, command output, web pages) is masked
 *                before the agent sees it. Only string values change, so each tool's output
 *                keeps its shape, which Claude Code requires.
 *   pre-tool     Placeholders in what the agent writes or runs are swapped back for the real
 *                values just before the tool runs, so files and commands get the real thing.
 *   session-start  Tells the agent what placeholders are and how to work with them. Without this,
 *                  real Claude Code runs showed the agent taking placeholders for mistakes and
 *                  dumping file bytes (od -c) to read the real value back.
 *   session-end  The session's vault is deleted.
 *
 * The vault (placeholder <-> value) is one file per session, readable only by you.
 */
import { detect, mask, restore, Vault } from '@veil/engine';
import type { EntityType, Finding, VaultEntry } from '@veil/engine';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface HookInput {
  session_id?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}

type Mode = 'session-start' | 'user-prompt' | 'pre-tool' | 'post-tool' | 'session-end';

/** What the agent is told at the start of every session. */
export const AGENT_GUIDE = [
  'Veil is active in this session. It hides secrets and personal data from you: in tool results they appear as placeholders such as [EMAIL_1] or [API_KEY_2]. The user installed Veil on purpose.',
  '- Treat each placeholder as the value itself and use it as-is in files you write and commands you run. Veil puts the real value back just before a file is written or a command runs, then hides it again in the output. A placeholder is never a mistake to fix.',
  "- Don't try to recover hidden values (no hex or byte dumps, od, xxd, base64, character-by-character reads, or similar), and don't ask the user for them.",
  "- To change a file that shows placeholders, rewrite the whole file with the Write tool, keeping the placeholders. Don't use Edit on text that contains a placeholder (the file on disk holds the real value, so Edit can't match it), and don't change such files with shell commands such as sed -i or > redirects: Claude Code then shows you the changed lines without Veil's masking.",
].join('\n');

/** Keys whose values are never masked or restored: they hold paths, types and binary data, not text. */
const SKIP_KEYS = new Set(['type', 'filePath', 'file_path', 'path', 'notebook_path', 'base64', 'media_type', 'mimeType']);

export function vaultPath(sessionId: string): string {
  const dir = process.env.VEIL_VAULT_DIR ?? join(tmpdir(), 'veil-claude-code');
  return join(dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_') || 'default'}.json`);
}

function loadVault(path: string): Vault {
  try {
    return Vault.fromJSON(JSON.parse(readFileSync(path, 'utf8')) as VaultEntry[]);
  } catch {
    return new Vault();
  }
}

function saveVault(path: string, vault: Vault): void {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(vault.toJSON()), { mode: 0o600 });
  chmodSync(path, 0o600);
}

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

const LABELS: Record<EntityType, [string, string]> = {
  EMAIL: ['email address', 'email addresses'],
  PHONE: ['phone number', 'phone numbers'],
  IBAN: ['IBAN', 'IBANs'],
  CARD: ['card number', 'card numbers'],
  IP: ['IP address', 'IP addresses'],
  API_KEY: ['API key', 'API keys'],
  PRIVATE_KEY: ['private key', 'private keys'],
  JWT: ['access token', 'access tokens'],
  SECRET: ['password or secret', 'passwords or secrets'],
};

/** "1 API key and 2 email addresses" */
export function describe(findings: readonly Finding[]): string {
  const counts = new Map<EntityType, number>();
  for (const f of findings) counts.set(f.type, (counts.get(f.type) ?? 0) + 1);
  const parts = [...counts].map(([t, n]) => `${n} ${LABELS[t][n === 1 ? 0 : 1]}`);
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** Runs one hook. Returns the JSON to print, or null to print nothing (no change). */
export function run(mode: Mode, input: HookInput): object | null {
  const path = vaultPath(input.session_id ?? 'default');

  switch (mode) {
    case 'session-start':
      return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: AGENT_GUIDE } };

    case 'user-prompt': {
      const prompt = input.prompt ?? '';
      if (detect(prompt).length === 0) return null;
      const vault = loadVault(path);
      const { text, findings } = mask(prompt, { vault });
      saveVault(path, vault);
      return {
        decision: 'block',
        reason:
          `Veil stopped this prompt: it contains ${describe(findings)}. Nothing was sent.\n` +
          `Send this version instead; Veil puts the real values back whenever the agent writes a file or runs a command:\n\n${text}`,
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
        suppressOutput: true,
      };
    }

    case 'post-tool': {
      if (input.tool_response === undefined) return null;
      const vault = loadVault(path);
      const before = vault.size;
      const masked = mapStrings(input.tool_response, (s) => mask(s, { vault }).text);
      if (masked === input.tool_response) return null;
      if (vault.size !== before) saveVault(path, vault);
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: masked }, suppressOutput: true };
    }

    case 'pre-tool': {
      if (!existsSync(path)) return null;
      const vault = loadVault(path);
      if (vault.size === 0) return null;
      const restored = mapStrings(input.tool_input, (s) => restore(s, vault));
      if (restored === input.tool_input) return null;
      // This output holds real values. Claude Code never sends a PreToolUse hook's output to the model
      // (checked in 2.1.312), but logs it in the local transcript; suppressOutput hides it from the on-screen view.
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: restored }, suppressOutput: true };
    }

    case 'session-end': {
      rmSync(path, { force: true });
      return null;
    }
  }
}

function main(): void {
  const mode = process.argv[2] as Mode;
  if (!['session-start', 'user-prompt', 'pre-tool', 'post-tool', 'session-end'].includes(mode)) {
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
