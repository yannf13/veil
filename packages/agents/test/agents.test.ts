import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { codex } from '../src/codex.js';
import { cursor } from '../src/cursor.js';
import { gemini } from '../src/gemini.js';

const here = dirname(fileURLToPath(import.meta.url));
// Fake, format-valid key assembled at runtime so secret scanners stay quiet.
const KEY = 'sk-proj-' + 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU1vW0xYz'.repeat(2);
const EMAIL = 'jane.doe@example.org';

let session: string;
let repo: string;
beforeEach(() => {
  process.env.VEIL_HOME = mkdtempSync(join(tmpdir(), 'veil-agents-home-'));
  process.env.VEIL_VAULT_DIR = join(process.env.VEIL_HOME, 'vaults');
  process.env.VEIL_MANAGED_CONFIG = join(process.env.VEIL_HOME, 'none.json');
  session = `s${Math.random().toString(36).slice(2)}`;
  repo = mkdtempSync(join(tmpdir(), 'veil-agents-repo-'));
  writeFileSync(join(repo, '.env'), `OPENAI_API_KEY=${KEY}\nOWNER=${EMAIL}\n`);
  writeFileSync(join(repo, 'README.md'), '# Demo\n');
});

describe('Codex', () => {
  const run = (event: string, extra: object) => codex(event, { session_id: session, cwd: repo, hook_event_name: event, ...extra }) as any;

  it('gives the agent the guide at the start', () => {
    expect(run('SessionStart', {}).hookSpecificOutput.additionalContext).toContain('apply_patch');
  });

  it('replaces command output with a masked version the model sees instead', () => {
    const out = run('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'cat .env' }, tool_response: readFileSync(join(repo, '.env'), 'utf8') });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('OPENAI_API_KEY=[API_KEY_1]\nOWNER=[EMAIL_1]');
    expect(out.reason).not.toContain(KEY);
    expect(out.reason).not.toContain(EMAIL);
    expect(run('PostToolUse', { tool_name: 'Bash', tool_response: 'all good' })).toBeNull();
  });

  it('restores placeholders in commands and patches, and refuses dumps of files with hidden values', () => {
    run('PostToolUse', { tool_name: 'Bash', tool_response: `OPENAI_API_KEY=${KEY}` });
    const bash = run('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer [API_KEY_1]" https://api.example.com' } });
    expect(bash.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { command: `curl -H "Authorization: Bearer ${KEY}" https://api.example.com` },
    });
    const patch = run('PreToolUse', { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n-OPENAI_API_KEY=[API_KEY_1]\n+OPENAI_API_KEY=[API_KEY_1]\n+TIMEOUT=60\n*** End Patch' } });
    expect(patch.hookSpecificOutput.updatedInput.command).toContain(`-OPENAI_API_KEY=${KEY}`);
    const dump = run('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'xxd .env' } });
    expect(dump.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(dump.hookSpecificOutput.permissionDecisionReason).toContain('.env holds values hidden from you');
    expect(run('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })).toBeNull();
  });

  it('blocks prompts with secrets and answers veil commands', () => {
    const blocked = run('UserPromptSubmit', { prompt: `deploy with ${KEY}` });
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toContain('deploy with [API_KEY_1]');
    expect(run('UserPromptSubmit', { prompt: 'veil show' }).reason).toContain(`[API_KEY_1]  ${KEY}`);
    expect(run('UserPromptSubmit', { prompt: 'refactor the parser' })).toBeNull();
  });
});

describe('Gemini CLI', () => {
  const run = (event: string, extra: object) => gemini(event, { session_id: session, cwd: repo, hook_event_name: event, ...extra }) as any;

  it('masks every message the model is sent, prompts included, with stable placeholders', () => {
    const out = run('BeforeModel', {
      llm_request: {
        model: 'gemini-2.5-pro',
        messages: [
          { role: 'user', content: `My key is ${KEY}, mail ${EMAIL}` },
          { role: 'model', content: 'Noted.' },
          { role: 'user', content: `Again: ${EMAIL}` },
        ],
      },
    });
    expect(out.hookSpecificOutput.llm_request.messages).toEqual([
      { role: 'user', content: 'My key is [API_KEY_1], mail [EMAIL_1]' },
      { role: 'model', content: 'Noted.' },
      { role: 'user', content: 'Again: [EMAIL_1]' },
    ]);
    expect(run('BeforeModel', { llm_request: { messages: [{ role: 'user', content: 'hello' }] } })).toBeNull();
  });

  it('replaces a tool result holding secrets with the masked version', () => {
    const out = run('AfterTool', { tool_name: 'read_file', tool_response: { llmContent: readFileSync(join(repo, '.env'), 'utf8'), returnDisplay: '' } });
    expect(out.decision).toBe('deny');
    expect(out.reason).toContain('OPENAI_API_KEY=[API_KEY_1]');
    expect(out.reason).not.toContain(KEY);
    const parts = run('AfterTool', { tool_name: 'web_fetch', tool_response: { llmContent: [{ text: `owner ${EMAIL}` }] } });
    expect(parts.reason).toContain('owner [EMAIL_1]');
  });

  it('restores placeholders in tool arguments, and refuses in-place shell edits', () => {
    run('AfterTool', { tool_name: 'read_file', tool_response: { llmContent: `OPENAI_API_KEY=${KEY}` } });
    const edit = run('BeforeTool', { tool_name: 'replace', tool_input: { file_path: join(repo, '.env'), old_string: 'OPENAI_API_KEY=[API_KEY_1]', new_string: 'OPENAI_API_KEY=[API_KEY_1]\nTIMEOUT=60' } });
    expect(edit.hookSpecificOutput.tool_input.old_string).toBe(`OPENAI_API_KEY=${KEY}`);
    expect(edit.hookSpecificOutput.tool_input.file_path).toBe(join(repo, '.env'));
    const sed = run('BeforeTool', { tool_name: 'run_shell_command', tool_input: { command: "sed -i 's/a/b/' .env" } });
    expect(sed.decision).toBe('deny');
    expect(sed.reason).toContain('Change it with the replace tool');
  });

  it('answers veil commands without the model, and stops messages with secrets', () => {
    expect(run('BeforeAgent', { prompt: 'veil help' })).toMatchObject({ decision: 'deny' });
    // gemini -p puts the session-start guide in front of the prompt
    expect(run('BeforeAgent', { prompt: '<hook_context>Veil is active…</hook_context>\n\nveil show' })).toMatchObject({ decision: 'deny' });
    const stop = run('BeforeAgent', { prompt: `ping ${EMAIL}` });
    expect(stop.decision).toBe('deny');
    expect(stop.reason).toContain('ping [EMAIL_1]');
    expect(run('BeforeAgent', { prompt: 'what does this repo do?' })).toBeNull();
  });
});

describe('Cursor', () => {
  const run = (event: string, extra: object) =>
    cursor(event, { conversation_id: session, workspace_roots: [repo], hook_event_name: event, ...extra }) as any;

  it('keeps files with secrets from the agent', () => {
    expect(run('beforeReadFile', { file_path: join(repo, '.env'), content: readFileSync(join(repo, '.env'), 'utf8') })).toEqual({
      permission: 'deny',
      user_message: 'Veil kept .env from the agent: it contains 1 API key and 1 email address.',
    });
    expect(run('beforeReadFile', { file_path: join(repo, 'README.md'), content: '# Demo\n' })).toEqual({ permission: 'allow' });
  });

  it('refuses commands that would print a file with secrets, since their output cannot be masked', () => {
    const out = run('beforeShellExecution', { command: 'cat .env', cwd: repo });
    expect(out.permission).toBe('deny');
    expect(out.agent_message).toContain('.env contains 1 API key and 1 email address');
    expect(run('beforeShellExecution', { command: 'cat README.md', cwd: repo })).toEqual({ permission: 'allow' });
  });

  it('stops prompts with secrets, and restores placeholders the user sent instead', () => {
    const stop = run('beforeSubmitPrompt', { prompt: `use ${KEY}` });
    expect(stop.continue).toBe(false);
    expect(stop.user_message).toContain('use [API_KEY_1]');
    const write = run('preToolUse', { tool_name: 'Write', tool_input: { file_path: join(repo, 'k.txt'), contents: 'KEY=[API_KEY_1]' } });
    expect(write).toEqual({ permission: 'allow', updated_input: { file_path: join(repo, 'k.txt'), contents: `KEY=${KEY}` } });
    expect(run('beforeSubmitPrompt', { prompt: 'hello' })).toEqual({ continue: true });
  });

  it('masks MCP results', () => {
    const out = run('postToolUse', { tool_name: 'MCP:crm_lookup', tool_output: JSON.stringify({ email: EMAIL }) });
    expect(out.updated_mcp_tool_output).toBe('{"email":"[EMAIL_1]"}');
    expect(run('postToolUse', { tool_name: 'Read', tool_output: EMAIL })).toBeNull();
  });
});

describe('the built script', () => {
  it('reads the hook input on stdin and prints the answer', () => {
    const out = execFileSync('node', [resolve(here, '../dist/veil-agent.mjs'), 'codex', 'PostToolUse'], {
      cwd: tmpdir(),
      input: JSON.stringify({ session_id: session, cwd: repo, tool_name: 'Bash', tool_response: `owner ${EMAIL}` }),
      env: { ...process.env },
    }).toString();
    expect(JSON.parse(out).reason).toContain('owner [EMAIL_1]');
  });
});
