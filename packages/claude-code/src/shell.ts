/**
 * Just enough shell reading to answer two questions about a command the agent wants to run:
 * which existing files it names, and whether it dumps bytes or edits a file in place.
 * Not a shell parser: it errs on the side of noticing.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** Words of a command, with quotes removed. Operators and redirections are split off. */
export function words(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/'([^']*)'|"((?:\\.|[^"\\])*)"|([^\s'"<>|;&()]+)|([<>|;&()]+)/g)) {
    const w = m[1] ?? m[2]?.replace(/\\(.)/g, '$1') ?? m[3] ?? m[4];
    if (w) out.push(w);
  }
  return out;
}

const MAX_READ = 2 * 1024 * 1024;

/** Existing regular files the command names, resolved against the working directory. */
export function filesIn(command: string, cwd: string): string[] {
  const seen = new Set<string>();
  // Whole words, and the path-like pieces inside them: open('.env') in a python -c script.
  const candidates = words(command).flatMap((w) => [w, ...w.split(/[^\w./~@+-]+/)]);
  for (let w of candidates) {
    w = w.replace(/^--?[\w-]+=/, ''); // --file=path
    if (w.length === 0 || w.length > 4096 || /^[-<>|;&()]/.test(w)) continue;
    const path = isAbsolute(w) ? w : resolve(cwd, w);
    try {
      if (existsSync(path) && statSync(path).isFile()) seen.add(path);
    } catch {
      // unreadable: not ours to judge
    }
  }
  return [...seen];
}

/** Files among `paths` that hold any of the hidden values. */
export function filesHolding(paths: readonly string[], values: readonly string[]): string[] {
  const wanted = values.filter((v) => v.length >= 4);
  if (wanted.length === 0) return [];
  return paths.filter((p) => {
    try {
      if (statSync(p).size > MAX_READ) return false;
      const text = readFileSync(p, 'utf8');
      return wanted.some((v) => text.includes(v));
    } catch {
      return false;
    }
  });
}

/** Tools and idioms that print a file's bytes in another form, or a character at a time. */
const DUMP =
  /(?:^|[\s;&|(`$])(?:od|xxd|hexdump|hd|base64|base32|basenc|uuencode|rev|strings)(?=\s|$)|\b(?:cut|colrm)\s+-[a-z]*[cb]|\b(?:head|tail)\s+(?:-[a-z]*c|--bytes)|\bfold\s+-w\s*1\b|\bord\s*\(|charCodeAt|codePointAt|\.hex\s*\(|\bunpack\s*\(|\bhexlify|\bb64encode|\bbtoa\s*\(|toString\s*\(\s*['"](?:hex|base64)/;

/** Commands that rewrite the files they are given: sed -i, perl -i, awk -i inplace, tee, truncate, sponge, ed. */
const REWRITES_ARGS =
  /\bsed\s+(?:[^|;&]*\s)?(?:-[a-zA-Z]*i|--in-place)|\bperl\s+(?:[^|;&]*\s)?-[a-zA-Z]*i|\bg?awk\s+-i\s*inplace|\btee\b|\btruncate\b|\bsponge\b|(?:^|[\s;&|])(?:ed|ex)\s/;

export const dumpsBytes = (command: string): boolean => DUMP.test(command);

/** Existing files the command would change in place: redirection targets, and the files given to sed -i and the like. */
export function filesChangedInPlace(command: string, cwd: string): string[] {
  const targets = new Set<string>();
  const ws = words(command);
  ws.forEach((w, i) => {
    if (/^&?>>?$|^>\|$/.test(w) && ws[i + 1] && ws[i + 1] !== '&') targets.add(ws[i + 1]!);
  });
  for (const m of command.matchAll(/\bdd\b[^|;&]*\bof=(\S+)/g)) targets.add(m[1]!);
  const existing = (list: Iterable<string>) => filesIn([...list].map((t) => JSON.stringify(t)).join(' '), cwd);
  const out = new Set(existing(targets));
  if (REWRITES_ARGS.test(command)) for (const f of filesIn(command, cwd)) out.add(f);
  return [...out];
}
