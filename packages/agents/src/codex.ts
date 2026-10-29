/**
 * Veil for Codex CLI (checked against Codex's hook code, Oct 2026: codex-rs/hooks and
 * codex-rs/core/src/tools/registry.rs).
 *
 *   SessionStart      the agent guide, as additionalContext
 *   UserPromptSubmit  "veil show" & co. answered, prompts with secrets blocked with the masked version
 *   PreToolUse        placeholders restored in Bash commands, apply_patch patches and MCP arguments
 *                     (permissionDecision "allow" + updatedInput); dumps and in-place edits of files
 *                     holding hidden values refused
 *   PostToolUse       Codex can't replace a tool result, but a blocked result is replaced by the
 *                     block reason in what the model sees: the reason carries the masked output.
 */
import { asText, checkPrompt, guideFor, maskTool, prepareInput, session, start } from './common.js';

export interface CodexInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}

const shellCommand = (toolName: string | undefined) => (input: unknown): string | null => {
  if (toolName === 'apply_patch' || toolName?.startsWith('mcp__')) return null;
  const command = (input as { command?: unknown } | null)?.command;
  return typeof command === 'string' ? command : null;
};

export function codex(event: string, input: CodexInput): object | null {
  const s = session('codex', input.session_id, input.cwd);
  switch (event) {
    case 'SessionStart':
      start(s);
      return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: guideFor('codex') } };

    case 'UserPromptSubmit': {
      const check = checkPrompt(s, input.prompt ?? '');
      if (!check) return null;
      const reason =
        check.kind === 'command'
          ? check.text
          : `Veil stopped this prompt: it contains ${check.summary}. Nothing was sent.\n` +
            `Send this version instead; Veil puts the real values back whenever the agent runs a command or applies a patch:\n\n${check.masked}`;
      // The Codex TUI shows the reason under the blocked prompt; `codex exec` prints only "Blocked".
      return { decision: 'block', reason };
    }

    case 'PreToolUse': {
      const { input: restored, refusal } = prepareInput(s, input.tool_input, shellCommand(input.tool_name));
      if (refusal) {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: refusal } };
      }
      if (restored === input.tool_input) return null;
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: restored } };
    }

    case 'PostToolUse': {
      const result = maskTool(s, input.tool_response);
      if (!result) return null;
      return {
        decision: 'block',
        reason:
          `[Veil] The tool ran. Its output held ${result.summary || 'a hidden value in another form'}, replaced below with placeholders; use them as they are.\n\n` +
          asText(result.masked),
      };
    }
  }
  return null;
}
