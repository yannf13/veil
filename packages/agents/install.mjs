#!/usr/bin/env node
// Adds Veil's hooks to Codex CLI or Cursor, next to any hooks you already have.
//
//   node packages/agents/install.mjs codex            ~/.codex/hooks.json
//   node packages/agents/install.mjs cursor           ~/.cursor/hooks.json
//   node packages/agents/install.mjs cursor --project .cursor/hooks.json in the current folder
//   ... --uninstall                                   removes Veil's hooks again
//   ... --home <dir>                                  another config folder
//
// Gemini CLI doesn't need this: gemini extensions install https://github.com/yannf13/veil
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, 'dist/veil-agent.mjs');
const args = process.argv.slice(2);
const host = args[0];
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const HOSTS = {
  codex: {
    dir: () => option('--home') ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'],
    entry: (event) => ({ hooks: [{ type: 'command', command: command('codex', event), timeout: 30 }] }),
    skeleton: () => ({ hooks: {} }),
    after: 'Codex asks you to review new hooks once: open Codex and approve the Veil hooks under /hooks.',
  },
  cursor: {
    dir: () => option('--home') ?? (flag('--project') ? resolve('.cursor') : join(homedir(), '.cursor')),
    events: ['sessionStart', 'beforeSubmitPrompt', 'beforeReadFile', 'beforeShellExecution', 'preToolUse', 'postToolUse'],
    // A check that can't run must not let a secret through.
    entry: (event) => ({
      command: command('cursor', event),
      timeout: 30,
      ...(['beforeSubmitPrompt', 'beforeReadFile', 'beforeShellExecution'].includes(event) && { failClosed: true }),
    }),
    skeleton: () => ({ version: 1, hooks: {} }),
    after: 'Restart Cursor so it loads the hooks.',
  },
};

function command(hostName, event) {
  return `node ${JSON.stringify(script)} ${hostName} ${event}`;
}

const target = HOSTS[host];
if (!target) {
  console.error('usage: node install.mjs <codex|cursor> [--project] [--home <dir>] [--uninstall]');
  process.exit(1);
}
if (!existsSync(script)) {
  console.error(`Missing ${script}. Run: npm run build -w @veil/agents`);
  process.exit(1);
}

const file = join(target.dir(), 'hooks.json');
let config = target.skeleton();
if (existsSync(file)) {
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`${file} is not valid JSON (${err.message}); fix or move it first.`);
    process.exit(1);
  }
}
config.hooks ??= {};

const isVeil = (entry) => JSON.stringify(entry).includes('veil-agent.mjs');
for (const event of Object.keys(config.hooks)) {
  config.hooks[event] = (config.hooks[event] ?? []).filter((entry) => !isVeil(entry));
  if (config.hooks[event].length === 0) delete config.hooks[event];
}
if (!flag('--uninstall')) {
  for (const event of target.events) (config.hooks[event] ??= []).push(target.entry(event));
}

mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
console.log(flag('--uninstall') ? `Removed Veil's hooks from ${file}.` : `Added Veil's hooks to ${file}.\n${target.after}`);
