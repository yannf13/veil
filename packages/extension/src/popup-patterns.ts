import type { CustomPattern } from '@veil/engine';

/** The popup's "Also hide" box: one pattern per line, "NAME regex". */
export function parsePatterns(text: string): CustomPattern[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(\S+)\s+(.+)$/.exec(line);
      return m ? { type: m[1]!.toUpperCase(), pattern: m[2]!.trim() } : { type: line.toUpperCase(), pattern: '' };
    });
}

export const formatPatterns = (patterns: readonly CustomPattern[]): string =>
  patterns.map((p) => `${p.type} ${p.pattern}`).join('\n');
