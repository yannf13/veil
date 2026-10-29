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
import { describeFindings, mask, restore } from '@veil/engine';
import { existsSync, readFileSync } from 'node:fs';
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
} from './core.js';
import type { VeilCommand } from './core.js';

export { loadPolicy, mapStrings, vaultPath, veilHome } from './core.js';

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
      touchVault(path); // a resumed session keeps its vault
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
      const { masked, findings } = maskOutput(input.tool_response, vault, policy);
      if (masked === input.tool_response) return null;
      if (vault.size !== before) saveVault(path, vault);
      audit(findings);
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: masked }, suppressOutput: true };
    }

    case 'pre-tool': {
      if (!existsSync(path)) return null;
      const vault = loadVault(path);
      if (vault.size === 0) return null;
      const restored = mapStrings(input.tool_input, (s) => restore(s, vault)) as Record<string, unknown> | undefined;

      const command = typeof restored?.command === 'string' ? restored.command : null;
      if (command !== null) {
        const refusal = refusalFor(command, input.cwd ?? process.cwd(), vault);
        if (refusal) return deny(refusal);
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
