import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
  process.env.VEIL_HOME = mkdtempSync(join(tmpdir(), 'veil-cc-home-'));
  process.env.VEIL_MANAGED_CONFIG = join(process.env.VEIL_HOME, 'no-managed-config.json');
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
  it('keeps the vault so the conversation can be resumed, until you say "veil forget"', () => {
    run('user-prompt', { session_id: session, prompt: `mail ${EMAIL}` });
    run('session-end', { session_id: session });
    expect(existsSync(vaultPath(session))).toBe(true);
    const out = run('user-prompt', { session_id: session, prompt: 'veil forget' }) as any;
    expect(out.reason).toContain('deleted the 1 hidden value');
    expect(existsSync(vaultPath(session))).toBe(false);
  });
});

describe('the built script', () => {
  it('reads hook input on stdin and prints Claude Code hook output', () => {
    const script = resolve(here, '../dist/veil-hook.mjs');
    const out = execFileSync('node', [script, 'post-tool'], {
      cwd: tmpdir(),
      input: JSON.stringify({ session_id: session, tool_name: 'Bash', tool_response: { stdout: EMAIL, stderr: '' } }),
      env: { ...process.env },
    }).toString();
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { stdout: '[EMAIL_1]', stderr: '' } },
      suppressOutput: true,
    });
  });
});

describe('your rules', () => {
  it("applies the project's .veil.json and yours together", () => {
    const repo = mkdtempSync(join(tmpdir(), 'veil-cc-repo-'));
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, '.veil.json'), JSON.stringify({ patterns: [{ type: 'TICKET', pattern: 'SEC-\\d+' }] }));
    writeFileSync(join(process.env.VEIL_HOME!, 'config.json'), JSON.stringify({ allow: ['*@example.org'] }));
    const out = run('post-tool', {
      session_id: session,
      cwd: join(repo, 'src'),
      tool_response: { stdout: `SEC-42 reported by ${EMAIL} and bob@acme.com` },
    }) as any;
    expect(out.hookSpecificOutput.updatedToolOutput.stdout).toBe(`[TICKET_1] reported by ${EMAIL} and [EMAIL_1]`);
  });

  it('reports mistakes at the start of the session, naming the file', () => {
    writeFileSync(join(process.env.VEIL_HOME!, 'config.json'), JSON.stringify({ patterns: [{ type: 'BAD', pattern: '(' }] }));
    const out = run('session-start', { session_id: session }) as any;
    expect(out.systemMessage).toContain('config.json: pattern BAD: not a valid regular expression');
    expect(out.hookSpecificOutput.additionalContext).toContain('placeholder');
  });
});

describe('veil commands', () => {
  it('"veil show" lists the hidden values for you, and nothing reaches the model', () => {
    run('post-tool', { session_id: session, tool_response: { stdout: `${KEY} ${EMAIL}` } });
    for (const prompt of ['veil show', '/veil show', 'Veil values']) {
      const out = run('user-prompt', { session_id: session, prompt }) as any;
      expect(out.decision).toBe('block');
      expect(out.reason).toContain(`[API_KEY_1]  ${KEY}`);
      expect(out.reason).toContain(`[EMAIL_1]    ${EMAIL}`);
    }
    const expansion = run('prompt-expansion', { session_id: session, command_name: 'veil:show', prompt: '/veil:show' }) as any;
    expect(expansion.decision).toBe('block');
    expect(expansion.hookSpecificOutput.hookEventName).toBe('UserPromptExpansion');
    expect(expansion.reason).toContain(KEY);
  });

  it('"veil stats" counts what was hidden, and the log holds no values', () => {
    run('post-tool', { session_id: session, tool_response: { stdout: `${KEY} ${EMAIL} other@example.org` } });
    const out = run('user-prompt', { session_id: session, prompt: 'veil stats' }) as any;
    expect(out.reason).toContain('Last 7 days:  1 API key and 2 email addresses');
    const log = readFileSync(join(process.env.VEIL_HOME!, 'audit.json'), 'utf8');
    expect(log).not.toContain('example.org');
    expect(log).not.toContain('sk-');
    expect(statSync(join(process.env.VEIL_HOME!, 'audit.json')).mode & 0o777).toBe(0o600);
  });

  it('leaves other prompts and commands alone', () => {
    expect(run('user-prompt', { session_id: session, prompt: 'show me the veil component' })).toBeNull();
    expect(run('prompt-expansion', { session_id: session, command_name: 'review' })).toBeNull();
  });
});

describe('hidden values in another form', () => {
  const hiddenKey = () => run('post-tool', { session_id: session, tool_response: { stdout: `OPENAI_API_KEY=${KEY}` } });
  const output = (stdout: string) =>
    (run('post-tool', { session_id: session, tool_name: 'Bash', tool_response: { stdout, stderr: '' } }) as any)
      ?.hookSpecificOutput.updatedToolOutput.stdout as string | undefined;
  const odC = (s: string) =>
    [...s].reduce((acc, ch, i) => acc + (i % 16 === 0 ? `\n${(i).toString(8).padStart(7, '0')}` : '') + `   ${ch}`, '');
  const xxd = (s: string) => {
    const b = Buffer.from(s);
    const lines: string[] = [];
    for (let i = 0; i < b.length; i += 16) {
      const chunk = b.subarray(i, i + 16);
      const hex = (chunk.toString('hex').match(/.{1,4}/g) ?? []).join(' ');
      lines.push(`${i.toString(16).padStart(8, '0')}: ${hex.padEnd(39)}  ${chunk.toString('latin1')}`);
    }
    return lines.join('\n');
  };

  it.each([
    ['od -c', () => odC(`OPENAI_API_KEY=${KEY}\n`)],
    ['xxd', () => xxd(`OPENAI_API_KEY=${KEY}\n`)],
    ['plain hex', () => Buffer.from(`x${KEY}`).toString('hex')],
    ['base64', () => Buffer.from(`OPENAI_API_KEY=${KEY}`).toString('base64')],
    ['reversed', () => [...KEY].reverse().join('')],
    ['char codes', () => `[${[...KEY].map((c) => c.charCodeAt(0)).join(', ')}]`],
  ])('withholds output that shows a hidden key as %s', (_name, make) => {
    hiddenKey();
    const out = output(make());
    expect(out).toMatch(/^\[Veil withheld this output: it shows a hidden value in another form/);
  });

  it('lets ordinary dumps through', () => {
    hiddenKey();
    expect(output(xxd('hello world, nothing secret in here at all'))).toBeUndefined();
    expect(output(Buffer.from('just some text').toString('base64'))).toBeUndefined();
  });
});

describe('commands that would expose hidden values', () => {
  function repoWithSecret(): string {
    const dir = mkdtempSync(join(tmpdir(), 'veil-cc-cmd-'));
    writeFileSync(join(dir, '.env'), `OPENAI_API_KEY=${KEY}\n`);
    writeFileSync(join(dir, 'notes.txt'), 'nothing to hide\n');
    run('post-tool', { session_id: session, tool_response: { stdout: `OPENAI_API_KEY=${KEY}` } });
    return dir;
  }
  const bash = (command: string, cwd: string) =>
    run('pre-tool', { session_id: session, cwd, tool_name: 'Bash', tool_input: { command } }) as any;

  it.each(['od -c .env', 'xxd .env | head', 'base64 < .env', 'cut -c1-20 .env', "python3 -c \"print([ord(c) for c in open('.env').read()])\""])(
    'refuses to dump a file holding hidden values: %s',
    (command) => {
      const dir = repoWithSecret();
      const out = bash(command, dir);
      expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain('.env holds values hidden from you');
      expect(out.hookSpecificOutput.permissionDecisionReason).not.toContain(KEY);
    },
  );

  it.each(["sed -i 's/OPENAI/OPEN_AI/' .env", 'echo X=1 >> .env', 'echo X=1 | tee -a .env', "perl -pi -e 's/a/b/' .env"])(
    'refuses to edit such a file in place: %s',
    (command) => {
      const dir = repoWithSecret();
      const out = bash(command, dir);
      expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain('Change it with the Write tool');
    },
  );

  it.each(['cat .env', 'od -c notes.txt', "sed -i 's/a/b/' notes.txt", 'cat .env > .env.backup', 'grep KEY .env 2>&1'])(
    'allows everything else: %s',
    (command) => {
      const dir = repoWithSecret();
      const out = bash(command, dir);
      expect(out?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    },
  );
});

describe('what you see on screen', () => {
  it("shows real values in the agent's reply, and only on screen", () => {
    run('post-tool', { session_id: session, tool_response: { stdout: `${KEY} ${EMAIL}` } });
    const out = run('message-display', { session_id: session, delta: 'I set the owner to \\[EMAIL\\_1\\] and the key to [API_KEY_1].\n' }) as any;
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: 'MessageDisplay',
      displayContent: `I set the owner to ${EMAIL} and the key to ${KEY}.\n`,
    });
  });

  it('keeps placeholders on screen when you set "showRealValues": false', () => {
    run('post-tool', { session_id: session, tool_response: { stdout: EMAIL } });
    writeFileSync(join(process.env.VEIL_HOME!, 'config.json'), JSON.stringify({ showRealValues: false }));
    expect(run('message-display', { session_id: session, delta: 'Owner: [EMAIL_1]\n' })).toBeNull();
  });

  it('stays silent when there is nothing to show', () => {
    expect(run('message-display', { session_id: session, delta: 'No placeholders here.\n' })).toBeNull();
    expect(run('message-display', { session_id: session, delta: 'Unknown [EMAIL_9].\n' })).toBeNull();
  });
});

describe('vaults left behind', () => {
  it('are cleared after a month without use, at the start of the next session', () => {
    run('user-prompt', { session_id: 'old', prompt: `mail ${EMAIL}` });
    run('user-prompt', { session_id: 'recent', prompt: `mail ${EMAIL}` });
    const monthAgo = (Date.now() - 31 * 24 * 3600_000) / 1000;
    utimesSync(vaultPath('old'), monthAgo, monthAgo);
    run('session-start', { session_id: session });
    expect(existsSync(vaultPath('old'))).toBe(false);
    expect(existsSync(vaultPath('recent'))).toBe(true);
  });
});

describe('names and addresses', () => {
  it('hides them in tool output too', () => {
    const out = run('post-tool', {
      session_id: session,
      tool_response: { stdout: 'Customer: Jane Doe, 12 rue de la Paix, 75002 Paris' },
    }) as any;
    expect(out.hookSpecificOutput.updatedToolOutput.stdout).toBe('Customer: [NAME_1], [ADDRESS_1]');
  });
});
