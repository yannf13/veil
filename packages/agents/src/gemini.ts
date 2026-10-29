/**
 * Veil for Gemini CLI (checked against Gemini CLI 0.66's bundled code).
 *
 *   SessionStart  the agent guide, as additionalContext
 *   BeforeAgent   "veil show" & co. answered, and messages with secrets stopped with the masked
 *                 version, by blocking the turn (the reason is shown; nothing is sent or kept in history)
 *   BeforeModel   every text message of every main model request is masked with the session's
 *                 vault, as a second line of defence. Gemini CLI swaps the text of each message in
 *                 order and keeps non-text parts.
 *   BeforeTool    placeholders restored in tool arguments; dumps and in-place edits refused
 *   AfterTool     a tool result with hidden values is blocked, and the block reason, which replaces
 *                 the result for the model, carries the masked output
 */
import { asText, checkPrompt, guideFor, loadPolicy, loadVault, maskTool, prepareInput, saveVault, session, start } from './common.js';
import { mask } from '@veil/engine';

export interface GeminiInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  prompt?: string;
  llm_request?: { messages?: Array<{ role: string; content: string }> };
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: { llmContent?: unknown; returnDisplay?: unknown; error?: unknown };
}

const shellCommand = (toolName: string | undefined) => (input: unknown): string | null => {
  if (toolName !== 'run_shell_command') return null;
  const command = (input as { command?: unknown } | null)?.command;
  return typeof command === 'string' ? command : null;
};

export function gemini(event: string, input: GeminiInput): object | null {
  const s = session('gemini', input.session_id, input.cwd);
  switch (event) {
    case 'SessionStart':
      start(s);
      return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: guideFor('gemini') } };

    case 'BeforeAgent': {
      // Blocked, not just masked: with the default "auto" model, Gemini CLI first sends the prompt to a
      // routing model, and that request skips BeforeModel (seen in Gemini CLI 0.66).
      // In non-interactive runs Gemini CLI puts the SessionStart guide in front of the prompt.
      const prompt = (input.prompt ?? '').replace(/^\s*(?:<hook_context>[\s\S]*?<\/hook_context>\s*)+/, '');
      const check = checkPrompt(s, prompt);
      if (!check) return null;
      return {
        decision: 'deny',
        reason:
          check.kind === 'command'
            ? check.text
            : `Veil stopped this message: it contains ${check.summary}. Nothing was sent.
` +
              `Send this version instead; Veil puts the real values back whenever the agent runs a command or writes a file:\n\n${check.masked}`,
      };
    }

    case 'BeforeModel': {
      const messages = input.llm_request?.messages;
      if (!Array.isArray(messages) || messages.length === 0) return null;
      const { policy } = loadPolicy(s.cwd);
      const vault = loadVault(s.path);
      const before = vault.size;
      let changed = false;
      const masked = messages.map((m) => {
        if (typeof m?.content !== 'string') return m;
        const { text, findings } = mask(m.content, { vault, ...policy.options });
        if (findings.length === 0) return m;
        changed = true;
        return { ...m, content: text };
      });
      if (!changed) return null;
      if (vault.size !== before) saveVault(s.path, vault);
      return { hookSpecificOutput: { hookEventName: 'BeforeModel', llm_request: { messages: masked } } };
    }

    case 'BeforeTool': {
      const { input: restored, refusal } = prepareInput(s, input.tool_input, shellCommand(input.tool_name));
      if (refusal) return { decision: 'deny', reason: refusal };
      if (restored === input.tool_input) return null;
      return { hookSpecificOutput: { hookEventName: 'BeforeTool', tool_input: restored } };
    }

    case 'AfterTool': {
      const content = input.tool_response?.llmContent;
      if (content === undefined) return null;
      const result = maskTool(s, content);
      if (!result) return null;
      return {
        decision: 'deny',
        reason:
          `[Veil] The tool ran. Its result held ${result.summary || 'a hidden value in another form'}, replaced below with placeholders; use them as they are.\n\n` +
          asText(result.masked),
      };
    }
  }
  return null;
}
