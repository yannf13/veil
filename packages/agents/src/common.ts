/**
 * The steps every agent integration takes, whatever the host's hook format: check a prompt, mask a
 * tool's output, restore placeholders in a tool's input. Hosts differ only in how they say it.
 */
import { describeFindings, mask, restore } from '@veil/engine';
import type { Finding } from '@veil/engine';
import {
  answer,
  audit,
  clearStaleVaults,
  loadPolicy,
  loadVault,
  mapStrings,
  maskOutput,
  refusalFor,
  saveVault,
  touchVault,
  vaultPath,
  veilCommand,
} from '../../claude-code/src/core.js';

export type Host = 'codex' | 'gemini' | 'cursor';

export interface Session {
  host: Host;
  /** The host's session or conversation id, prefixed with the host so ids never collide. */
  id: string;
  cwd: string;
  path: string;
}

export function session(host: Host, id: string | undefined, cwd: string | undefined): Session {
  const sid = `${host}-${id || 'default'}`;
  return { host, id: sid, cwd: cwd || process.cwd(), path: vaultPath(sid) };
}

const TOOL_WORDS: Record<Host, { write: string; edit: string }> = {
  codex: { write: 'apply_patch', edit: 'apply_patch' },
  gemini: { write: 'write_file', edit: 'replace' },
  cursor: { write: 'file editing', edit: 'file editing' },
};

/** What the agent is told when a session starts. */
export function guideFor(host: Host): string {
  const t = TOOL_WORDS[host];
  return [
    'Veil is active in this session. It hides secrets and personal data from you: in prompts and tool results they appear as placeholders such as [EMAIL_1] or [API_KEY_2]. The user installed Veil on purpose and knows the real values.',
    '- Treat each placeholder as the value itself and use it as-is in files you write and commands you run. Veil puts the real value back just before a file is written or a command runs, then hides it again in the output. A placeholder is never a mistake to fix.',
    "- Don't try to recover hidden values (no hex or byte dumps, od, xxd, base64, character-by-character reads, or similar), and don't ask the user for them. Veil refuses such commands on files that hold hidden values and withholds output that shows them in another form.",
    `- To change a file that shows placeholders, use ${t.edit === t.write ? t.edit : `${t.edit} or ${t.write}`} and keep the placeholders exactly as you saw them. Don't change such files with shell commands such as sed -i or > redirects.`,
    ...(host === 'cursor'
      ? ["- Files and command output that contain secrets are kept from you entirely: Cursor's hooks can't mask them. If a read or a command is refused, work around the file or ask the user to do that step."]
      : []),
  ].join('\n');
}

export function start(s: Session): void {
  clearStaleVaults();
  touchVault(s.path);
}

export type PromptCheck =
  | { kind: 'command'; text: string }
  | { kind: 'secrets'; masked: string; findings: Finding[]; summary: string }
  | null;

/** A prompt is either a Veil command, a text with secrets in it, or fine. */
export function checkPrompt(s: Session, prompt: string, { saveValues = true } = {}): PromptCheck {
  const command = veilCommand(prompt);
  if (command) return { kind: 'command', text: answer(command, s.id, s.cwd) };
  const { policy } = loadPolicy(s.cwd);
  const vault = loadVault(s.path);
  const { text, findings } = mask(prompt, { vault, ...policy.options });
  if (findings.length === 0) return null;
  if (saveValues) saveVault(s.path, vault);
  audit(findings);
  return { kind: 'secrets', masked: text, findings, summary: describeFindings(findings, policy.labels) };
}

/** Masks a tool's output. Returns null when there was nothing to hide. */
export function maskTool(s: Session, output: unknown): { masked: unknown; summary: string; withheld: boolean } | null {
  const { policy } = loadPolicy(s.cwd);
  const vault = loadVault(s.path);
  const before = vault.size;
  const { masked, findings, withheld } = maskOutput(output, vault, policy);
  if (masked === output) return null;
  if (vault.size !== before) saveVault(s.path, vault);
  audit(findings);
  return { masked, summary: describeFindings(findings, policy.labels), withheld };
}

export interface PreparedInput {
  /** The input with placeholders replaced by real values; the same object when nothing changed. */
  input: unknown;
  /** Why the tool must not run, for the agent. */
  refusal: string | null;
}

/**
 * Restores placeholders in a tool's input, and refuses shell commands that would dump or edit in
 * place a file holding hidden values. `shellCommand` reads the command out of a restored input.
 */
export function prepareInput(s: Session, input: unknown, shellCommand: (input: unknown) => string | null): PreparedInput {
  const vault = loadVault(s.path);
  if (vault.size === 0) return { input, refusal: null };
  const restored = mapStrings(input, (v) => restore(v, vault));
  const command = shellCommand(restored);
  const refusal = command === null ? null : refusalFor(command, s.cwd, vault, TOOL_WORDS[s.host].edit);
  return { input: restored, refusal };
}

export { loadPolicy, loadVault, saveVault, mapStrings };

/** Flattens what a tool returned into text the model can read: strings, text parts, or JSON. */
export function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.text === 'string') return v.text;
    if (v.functionResponse && typeof v.functionResponse === 'object') return asText((v.functionResponse as Record<string, unknown>).response);
    return JSON.stringify(value);
  }
  return value === undefined || value === null ? '' : String(value);
}
