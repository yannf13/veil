/**
 * One script for the agents other than Claude Code: node veil-agent.mjs <codex|gemini|cursor> <event>.
 * Reads the hook's JSON on stdin, prints the answer as JSON. On an internal error it says so on
 * stderr and exits 1, which every host treats as "hook failed, carry on".
 */
import { readFileSync } from 'node:fs';
import { codex } from './codex.js';
import { cursor } from './cursor.js';
import { gemini } from './gemini.js';

const HOSTS = { codex, gemini, cursor } as const;

function main(): void {
  const [host, event] = process.argv.slice(2) as [keyof typeof HOSTS, string];
  const run = HOSTS[host];
  if (!run || !event) {
    process.stderr.write('usage: veil-agent.mjs <codex|gemini|cursor> <event>\n');
    process.exit(1);
  }
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}') as Record<string, unknown>;
  } catch {
    process.stderr.write('veil: could not read the hook input\n');
    process.exit(1);
  }
  try {
    const out = run(event, input as never);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err) {
    process.stderr.write(`veil: ${host} ${event} hook failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

main();
