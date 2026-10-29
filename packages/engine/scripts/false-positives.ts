/**
 * Runs the detectors over a folder of ordinary text (docs, code, licenses) and prints what they
 * flag, with context, to spot false positives. Everything flagged in such a corpus is a candidate.
 *   T=NAME npx tsx scripts/false-positives.ts ../../node_modules/typescript /usr/lib/python3.12
 * T picks the kind (NAME, ADDRESS, SECRET, PHONE, IP, EMAIL...).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { detect } from '../src/index.ts';
const files: string[] = [];
const walk = (d: string, depth = 0) => {
  if (depth > 6 || files.length > 4000) return;
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, depth + 1);
    else if (/\.(md|ts|js|mjs|txt|json|py)$/.test(n) && st.size < 200_000 && !/\.min\.|first-names/.test(n)) files.push(p);
  }
};
process.argv.slice(2).forEach((r) => walk(r));
const seen = new Map<string, string>();
for (const f of files) {
  const t = readFileSync(f, 'utf8');
  for (const x of detect(t, { types: [(process.env.T ?? 'NAME') as never] })) if (!seen.has(x.value)) seen.set(x.value, t.slice(Math.max(0, x.start - 25), x.end + 15).replace(/\s+/g, ' '));
}
const all = [...seen];
// deterministic shuffle
all.sort((a, b) => ((a[0].length * 7919 + a[0].charCodeAt(1) * 31) % 97) - ((b[0].length * 7919 + b[0].charCodeAt(1) * 31) % 97));
console.log(all.length, 'unique values flagged');
for (const [v, ctx] of all.slice(0, 150)) console.log(JSON.stringify(v), '  ‹', ctx, '›');
