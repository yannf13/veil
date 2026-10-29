import type { BuiltinEntityType, EntityType, Finding } from './types.js';

/** Human words for each kind: [singular, plural]. */
export const LABELS: Record<BuiltinEntityType, readonly [string, string]> = {
  EMAIL: ['email address', 'email addresses'],
  PHONE: ['phone number', 'phone numbers'],
  IBAN: ['IBAN', 'IBANs'],
  CARD: ['card number', 'card numbers'],
  IP: ['IP address', 'IP addresses'],
  API_KEY: ['API key', 'API keys'],
  PRIVATE_KEY: ['private key', 'private keys'],
  JWT: ['access token', 'access tokens'],
  SECRET: ['password or secret', 'passwords or secrets'],
  NAME: ['name', 'names'],
  ADDRESS: ['postal address', 'postal addresses'],
};

export type Labels = Readonly<Record<string, readonly [string, string]>>;

/** "PROJECT_CODE" -> ["project code", "project codes"] for kinds without a label. */
function fallbackLabel(type: EntityType): readonly [string, string] {
  const words = type.toLowerCase().replace(/_/g, ' ');
  return [words, words.endsWith('s') ? words : `${words}s`];
}

export function labelFor(type: EntityType, n: number, labels: Labels = LABELS): string {
  const [one, many] = labels[type] ?? LABELS[type as BuiltinEntityType] ?? fallbackLabel(type);
  return n === 1 ? one : many;
}

/** How many findings of each kind. Holds no values, so it is safe to log and to show. */
export function tally(findings: readonly Pick<Finding, 'type'>[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.type] = (counts[f.type] ?? 0) + 1;
  return counts;
}

/** "2 email addresses, 1 IBAN and 1 API key". Empty string for no findings. */
export function describeFindings(findings: readonly Pick<Finding, 'type'>[], labels?: Labels): string {
  return describeCounts(tally(findings), labels);
}

export function describeCounts(counts: Readonly<Record<string, number>>, labels?: Labels): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([type, n]) => `${n} ${labelFor(type, n, labels)}`);
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}
