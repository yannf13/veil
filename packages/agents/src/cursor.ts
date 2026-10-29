/**
 * Veil for Cursor (built from Cursor's documented hooks, cursor.com/docs/hooks, Oct 2026; Cursor
 * itself is closed source and was not run). Cursor's hooks can't change what a file read or a shell
 * command returns, so Veil keeps those from the agent when they hold secrets, instead of masking.
 *
 *   sessionStart          the agent guide
 *   beforeSubmitPrompt    "veil show" & co. answered; prompts with secrets stopped with the masked version
 *   beforeReadFile        reads of files that contain secrets refused
 *   beforeShellExecution  commands that name a file containing secrets refused (their output can't be
 *                         masked); dumps and in-place edits refused
 *   preToolUse            placeholders restored in tool arguments (updated_input)
 *   postToolUse           MCP results masked (updated_mcp_tool_output, the only output Cursor lets
 *                         hooks change)
 */
import { describeFindings, detect } from '@veil/engine';
import { readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { filesIn } from '../../claude-code/src/shell.js';
import { checkPrompt, guideFor, loadPolicy, maskTool, prepareInput, session, start } from './common.js';

export interface CursorInput {
  hook_event_name?: string;
  conversation_id?: string;
  session_id?: string;
  workspace_roots?: string[];
  cwd?: string;
  prompt?: string;
  file_path?: string;
  content?: string;
  command?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
}

const MAX_READ = 2 * 1024 * 1024;

/** Kinds of secrets in a text, in words, or null. */
function secretsIn(text: string, cwd: string): string | null {
  const { policy } = loadPolicy(cwd);
  const findings = detect(text, policy.options);
  return findings.length ? describeFindings(findings, policy.labels) : null;
}

const isShellTool = (name: string | undefined) => !!name && /^(shell|terminal|run_terminal_cmd|bash)$/i.test(name);

export function cursor(event: string, input: CursorInput): object | null {
  const cwd = input.cwd || input.workspace_roots?.[0] || process.env.CURSOR_PROJECT_DIR;
  const s = session('cursor', input.conversation_id ?? input.session_id, cwd);
  switch (event) {
    case 'sessionStart':
      start(s);
      return { additional_context: guideFor('cursor') };

    case 'beforeSubmitPrompt': {
      const check = checkPrompt(s, input.prompt ?? '');
      if (!check) return { continue: true };
      return {
        continue: false,
        user_message:
          check.kind === 'command'
            ? check.text
            : `Veil stopped this prompt: it contains ${check.summary}. Nothing was sent.\nSend this version instead; Veil puts the real values back whenever the agent edits a file or runs a command:\n\n${check.masked}`,
      };
    }

    case 'beforeReadFile': {
      const kinds = typeof input.content === 'string' ? secretsIn(input.content, s.cwd) : null;
      if (!kinds) return { permission: 'allow' };
      const name = input.file_path ? relative(s.cwd, input.file_path) || input.file_path : 'this file';
      return { permission: 'deny', user_message: `Veil kept ${name} from the agent: it contains ${kinds}.` };
    }

    case 'beforeShellExecution': {
      const command = input.command ?? '';
      const { refusal } = prepareInput(s, { command }, (i) => (i as { command: string }).command);
      if (refusal) return { permission: 'deny', agent_message: refusal, user_message: refusal };
      for (const file of filesIn(command, s.cwd)) {
        try {
          if (statSync(file).size > MAX_READ) continue;
          const kinds = secretsIn(readFileSync(file, 'utf8'), s.cwd);
          if (!kinds) continue;
          const name = relative(s.cwd, file) || file;
          return {
            permission: 'deny',
            agent_message: `Veil: ${name} contains ${kinds}, and Cursor can't mask command output, so this command was not run. Work without reading that file, or ask the user to run it.`,
            user_message: `Veil kept ${name} from the agent: it contains ${kinds}.`,
          };
        } catch {
          // unreadable: let Cursor decide
        }
      }
      return { permission: 'allow' };
    }

    case 'preToolUse': {
      const shell = (i: unknown) => (isShellTool(input.tool_name) && typeof (i as { command?: unknown })?.command === 'string' ? (i as { command: string }).command : null);
      const { input: restored, refusal } = prepareInput(s, input.tool_input, shell);
      if (refusal) return { permission: 'deny', agent_message: refusal };
      if (restored === input.tool_input) return { permission: 'allow' };
      return { permission: 'allow', updated_input: restored };
    }

    case 'postToolUse': {
      if (!input.tool_name?.startsWith('MCP:') && !input.tool_name?.startsWith('mcp_') && !input.tool_name?.includes('__')) return null;
      const result = maskTool(s, input.tool_output);
      return result ? { updated_mcp_tool_output: result.masked } : null;
    }
  }
  return null;
}
