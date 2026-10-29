/**
 * Hidden values that come back in another form: a hex dump, base64, one character per column
 * (od -c), reversed, URL-encoded or as character codes. Plain masking can't see those, so
 * tool output is checked for every value in the session's vault.
 */

/** Line prefixes that dump tools print: "0000020 ", "00000010: ". */
const OFFSET = /^[ \t]*[0-9a-fA-F]{6,10}:?(?=[ \t]|$)/gm;
/** The text column at the end of hexdump -C ("|sk-proj-…|") and xxd ("  sk-proj-…") lines. */
const HEXDUMP_TEXT = /[ \t]+\|[^\n|]*\|[ \t]*$/gm;
const XXD_TEXT = /^((?:[ \t]*[0-9a-fA-F]{6,10}:)?(?:[ \t]+[0-9a-fA-F]{2,4})+)[ \t]{2,}\S.*$/gm;

const MIN = 6;

function hexOf(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex');
}

/** The byte stream a dump shows, as hex: offsets and text columns removed. */
function dumpedHex(text: string): string {
  return text
    .replace(XXD_TEXT, '$1')
    .replace(HEXDUMP_TEXT, '')
    .replace(OFFSET, '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
}

/** od -x prints 16-bit little-endian words: "6b73 702d" is "sk-p". */
function swappedWords(text: string): string {
  const words = text.replace(OFFSET, '').match(/\b[0-9a-f]{4}\b/gi) ?? [];
  return words.map((w) => w.slice(2) + w.slice(0, 2)).join('').toLowerCase();
}

/** The text column of xxd and hexdump -C dumps, joined across lines. */
function textColumns(text: string): string {
  const cols: string[] = [];
  for (const m of text.matchAll(/\|([^\n|]*)\|[ \t]*$/gm)) cols.push(m[1]!);
  for (const m of text.matchAll(/^[ \t]*[0-9a-fA-F]{6,10}:(?:[ \t]+[0-9a-fA-F]{2,4})+[ \t]{2,}(\S.*)$/gm)) cols.push(m[1]!);
  return cols.join('');
}

/** Middle parts of a value's base64 that don't depend on where it starts in the encoded data. */
function base64Cores(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  const cores: string[] = [];
  for (let shift = 0; shift < 3; shift++) {
    const b64 = Buffer.concat([Buffer.alloc(shift), bytes]).toString('base64');
    // Drop the characters touched by the padding bytes in front and by the unknown bytes after.
    const start = Math.ceil((shift * 4) / 3);
    const core = b64.slice(start, b64.length - 4);
    if (core.length >= 8) cores.push(core, core.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  return cores;
}

export type LeakKind = 'hex dump' | 'base64' | 'one character at a time' | 'reversed' | 'URL-encoded' | 'character codes';

/** The way `text` shows one of `values` in disguise, or null. Plain occurrences are masking's job. */
export function encodedLeak(text: string, values: readonly string[]): LeakKind | null {
  const candidates = values.filter((v) => v.length >= MIN);
  if (candidates.length === 0 || text.length < MIN) return null;

  const withoutOffsets = text.replace(OFFSET, '');
  const hex = dumpedHex(text);
  const swapped = swappedWords(text);
  const columns = textColumns(text);
  const compact = text.replace(/\s+/g, '');

  for (const value of candidates) {
    const plain = value.replace(/\s+/g, '');
    if (plain.length >= 8) {
      // od -c: every character on its own, separated by blanks and line offsets.
      const spaced = new RegExp([...plain].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
      if (spaced.test(withoutOffsets)) return 'one character at a time';
      if (!text.includes(value) && columns.replace(/\s+/g, '').includes(plain)) return 'one character at a time';
    }
    const h = hexOf(value);
    if (hex.includes(h) || swapped.includes(h) || text.toLowerCase().includes(h)) return 'hex dump';
    if (base64Cores(value).some((core) => text.includes(core))) return 'base64';
    if (plain.length >= 8 && text.includes([...value].reverse().join(''))) return 'reversed';
    const url = encodeURIComponent(value);
    if (url !== value && text.includes(url)) return 'URL-encoded';
    const codes = [...value].map((c) => c.codePointAt(0)).join(',');
    if (compact.includes(codes)) return 'character codes';
  }
  return null;
}
