import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { run, vaultPath } from '../src/hook.js';

const here = dirname(fileURLToPath(import.meta.url));
// Fake, format-valid key assembled at runtime so secret scanners stay quiet.
const KEY = 'sk-proj-' + 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU1vW0xYz'.repeat(2);
const EMAIL = 'jane.doe@example.org';

let session: string;
beforeEach(() => {
  process.env.VEIL_VAULT_DIR = mkdtempSync(join(tmpdir(), 'veil-cc-test-'));
  session = `s${Math.random().toString(36).slice(2)}`;
});

describe('start of session', () => {
  it('tells the agent how placeholders work and not to recover them', () => {
    const out = run('session-start', { session_id: session }) as any;
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('placeholder');
    expect(out.hookSpecificOutput.additionalContext).toContain("Don't try to recover hidden values");
  });
});

describe('typed prompts', () => {
  it('blocks a prompt with secrets and offers the masked version', () => {
    const out = run('user-prompt', { session_id: session, prompt: `Use ${KEY} and mail ${EMAIL}` }) as any;
    expect(out.decision).toBe('block');
    expect(out.hookSpecificOutput).toEqual({ hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true });
    expect(out.reason).toContain('1 API key and 1 email address');
    expect(out.reason).toContain('Use [API_KEY_1] and mail [EMAIL_1]');
    expect(out.reason).not.toContain(KEY);
    expect(out.reason).not.toContain(EMAIL);
  });

  it('lets clean prompts through untouched', () => {
    expect(run('user-prompt', { session_id: session, prompt: 'Refactor the parser please' })).toBeNull();
  });

  it('keeps the vault readable only by you', () => {
    run('user-prompt', { session_id: session, prompt: `mail ${EMAIL}` });
    expect(statSync(vaultPath(session)).mode & 0o777).toBe(0o600);
  });
});

describe('what tools return', () => {
  it('masks command output and keeps the Bash output shape', () => {
    const response = { stdout: `OPENAI_API_KEY=${KEY}\nowner=${EMAIL}\n`, stderr: '', interrupted: false, isImage: false };
    const out = run('post-tool', { session_id: session, tool_name: 'Bash', tool_response: response }) as any;
    const masked = out.hookSpecificOutput.updatedToolOutput;
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(Object.keys(masked)).toEqual(Object.keys(response));
    expect(masked).toMatchObject({ stderr: '', interrupted: false, isImage: false });
    expect(masked.stdout).toBe('OPENAI_API_KEY=[API_KEY_1]\nowner=[EMAIL_1]\n');
  });

  it('masks file contents but never the file path', () => {
    const response = { type: 'text', file: { filePath: '/repo/jane.doe@example.org.env', content: `KEY=${KEY}`, numLines: 1 } };
    const out = run('post-tool', { session_id: session, tool_name: 'Read', tool_response: response }) as any;
    expect(out.hookSpecificOutput.updatedToolOutput).toEqual({
      type: 'text',
      file: { filePath: '/repo/jane.doe@example.org.env', content: 'KEY=[API_KEY_1]', numLines: 1 },
    });
  });

  it('says nothing when there is nothing to hide', () => {
    const response = { stdout: 'all tests passed', stderr: '', interrupted: false, isImage: false };
    expect(run('post-tool', { session_id: session, tool_name: 'Bash', tool_response: response })).toBeNull();
  });
});

describe('what the agent writes or runs', () => {
  it('puts the real values back in files, edits and commands', () => {
    run('post-tool', { session_id: session, tool_response: { stdout: `${KEY} ${EMAIL}` } });

    const write = run('pre-tool', {
      session_id: session,
      tool_name: 'Write',
      tool_input: { file_path: '/repo/.env', content: 'OPENAI_API_KEY=[API_KEY_1]\n' },
    }) as any;
    expect(write.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      updatedInput: { file_path: '/repo/.env', content: `OPENAI_API_KEY=${KEY}\n` },
    });

    const edit = run('pre-tool', {
      session_id: session,
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/a.ts', old_string: 'to: "[EMAIL_1]"', new_string: 'to: process.env.OWNER' },
    }) as any;
    expect(edit.hookSpecificOutput.updatedInput.old_string).toBe(`to: "${EMAIL}"`);

    const bash = run('pre-tool', { session_id: session, tool_name: 'Bash', tool_input: { command: 'echo [EMAIL_1]' } }) as any;
    expect(bash.hookSpecificOutput.updatedInput.command).toBe(`echo ${EMAIL}`);
  });

  it('leaves input alone when there is nothing to restore', () => {
    expect(run('pre-tool', { session_id: session, tool_input: { command: 'ls' } })).toBeNull();
    run('post-tool', { session_id: session, tool_response: { stdout: EMAIL } });
    expect(run('pre-tool', { session_id: session, tool_input: { command: 'ls' } })).toBeNull();
  });
});

describe('end of session', () => {
  it('deletes the vault', () => {
    run('user-prompt', { session_id: session, prompt: `mail ${EMAIL}` });
    expect(existsSync(vaultPath(session))).toBe(true);
    run('session-end', { session_id: session });
    expect(existsSync(vaultPath(session))).toBe(false);
  });
});

describe('the built script', () => {
  it('reads hook input on stdin and prints Claude Code hook output', () => {
    const script = resolve(here, '../dist/veil-hook.mjs');
    const out = execFileSync('node', [script, 'post-tool'], {
      input: JSON.stringify({ session_id: session, tool_name: 'Bash', tool_response: { stdout: EMAIL, stderr: '' } }),
      env: { ...process.env },
    }).toString();
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { stdout: '[EMAIL_1]', stderr: '' } },
      suppressOutput: true,
    });
  });
});
