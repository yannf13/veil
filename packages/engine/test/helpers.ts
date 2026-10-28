import { detect } from '../src/index.js';
import type { EntityType } from '../src/index.js';

/**
 * Fake, format-valid secrets are assembled at runtime so secret scanners
 * (GitHub push protection and the like) don't flag this repository.
 * Deterministic: the same n always gives the same string, with close to uniform characters.
 */
export function fakeToken(n: number): string {
  const alphabet = 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU1vW0xYz';
  return Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join('');
}

/** Findings as [type, value] pairs, easier to compare in assertions. */
export function found(text: string): Array<[EntityType, string]> {
  return detect(text).map((f) => [f.type, f.value]);
}
