import type { Detector, EntityType, Finding } from './types.js';
import {
  IBAN_LENGTHS,
  alnumClassCount,
  digitsOnly,
  ibanValid,
  luhnValid,
  shannonEntropy,
} from './validators.js';

interface RegexRule {
  name: string;
  type: EntityType;
  priority: number;
  /** Must carry the `g` flag, and the `d` flag when `group` is set. */
  pattern: RegExp;
  /** Capture group holding the sensitive part; the whole match when omitted. */
  group?: number;
  /** Extra check on the value; return false to drop the match. */
  accept?: (value: string) => boolean;
}

function regexDetector(rule: RegexRule): Detector {
  return {
    name: rule.name,
    type: rule.type,
    priority: rule.priority,
    find(text: string): Finding[] {
      const out: Finding[] = [];
      for (const m of text.matchAll(rule.pattern)) {
        let start: number;
        let value: string;
        if (rule.group !== undefined) {
          const span = m.indices?.[rule.group];
          const v = m[rule.group];
          if (!span || v === undefined) continue;
          start = span[0];
          value = v;
        } else {
          start = m.index ?? 0;
          value = m[0];
        }
        if (value.length === 0) continue;
        if (rule.accept && !rule.accept(value)) continue;
        out.push({ type: rule.type, start, end: start + value.length, value, detector: rule.name });
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Secrets with a known shape
// ---------------------------------------------------------------------------

const privateKey = regexDetector({
  name: 'private-key-block',
  type: 'PRIVATE_KEY',
  priority: 100,
  pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
});

const jwt = regexDetector({
  name: 'jwt',
  type: 'JWT',
  priority: 95,
  pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
});

const apiKeyRules: Array<[name: string, pattern: RegExp, accept?: (v: string) => boolean]> = [
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9]{2,12}-[A-Za-z0-9_-]{20,}/g],
  [
    'openai-key',
    /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
    // Rules out long lowercase slugs such as "sk-learn-style-long-identifier".
    (v) => /\d/.test(v) && alnumClassCount(v) >= 2,
  ],
  ['stripe-key', /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['huggingface-token', /\bhf_[A-Za-z0-9]{30,}\b/g],
];

const apiKeys: Detector[] = apiKeyRules.map(([name, pattern, accept]) =>
  regexDetector({ name, type: 'API_KEY', priority: 90, pattern, ...(accept ? { accept } : {}) }),
);

/** postgres://user:PASSWORD@host — masks the password only. */
const connectionStringPassword = regexDetector({
  name: 'connection-string-password',
  type: 'SECRET',
  priority: 85,
  pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]+)@/gid,
  group: 1,
});

/** Values that look assigned to a secret-named key but are references or placeholders, not secrets. */
function looksLikeRealSecret(v: string): boolean {
  if (/^(true|false|null|none|nil|undefined|required|optional|string|number|boolean|secret|password)$/i.test(v)) return false;
  if (/^[$<{%[]/.test(v)) return false; // ${VAR}, <YOUR_KEY>, {{template}}, %s, [REDACTED]
  if (/[()]/.test(v)) return false; // function calls
  if (/^(process\.env|os\.environ|env\.|import\.meta)/.test(v)) return false;
  if (/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/.test(v)) return false; // config.apiKey
  if (/^(.)\1+$/.test(v)) return false; // ******** or xxxxxxxx
  if (/^your[_-]/i.test(v)) return false;
  return true;
}

/** API_KEY=..., "password": "...", client_secret: ... — masks the value only. */
const secretAssignment = regexDetector({
  name: 'secret-assignment',
  type: 'SECRET',
  priority: 60,
  pattern:
    /\b[A-Za-z0-9_.-]*?(?:password|passwd|passwort|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*(["']?)([^\s"'`,;]{6,})\1/gid,
  group: 2,
  accept: looksLikeRealSecret,
});

/** "my password is Soleil2024!", "mot de passe : ...", "Passwort ist ..." — needs a digit or symbol to count. */
const secretInProse = regexDetector({
  name: 'password-in-prose',
  type: 'SECRET',
  priority: 60,
  pattern: /\b(?:password|passwort|kennwort|mot de passe|mdp)\s*(?:is|ist|est)?\s*[:=]?\s*["']?([^\s"',;]{6,})/gid,
  group: 1,
  accept: (v) => {
    // Sentence punctuation at the end ("is required.") doesn't make a word look like a password,
    // but it stays in the masked value: over-masking a full stop is harmless, leaking a "!" is not.
    const core = v.replace(/[.!?:)]+$/, '');
    return /[\d\W_]/.test(core) && looksLikeRealSecret(core);
  },
});

/** Long random-looking tokens that no specific rule caught. Lowest priority. */
const highEntropyToken = regexDetector({
  name: 'high-entropy-token',
  type: 'SECRET',
  priority: 10,
  pattern: /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{24,}(?![A-Za-z0-9+/_=-])/g,
  accept: (v) => {
    if (alnumClassCount(v) < 3) return false; // needs lower, upper and digits
    if (/^[0-9a-f-]+$/i.test(v)) return false; // hashes, UUIDs
    if (/^sha(256|384|512)-/.test(v)) return false; // public integrity hashes in lockfiles and <script integrity>
    return shannonEntropy(v) >= 4.2;
  },
});

// ---------------------------------------------------------------------------
// Structured personal and financial data
// ---------------------------------------------------------------------------

const iban: Detector = {
  name: 'iban',
  type: 'IBAN',
  priority: 80,
  find(text) {
    const out: Finding[] = [];
    for (const m of text.matchAll(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,32}/gi)) {
      const start = m.index ?? 0;
      const raw = m[0];
      const len = IBAN_LENGTHS[raw.slice(0, 2).toUpperCase()];
      if (len === undefined) continue;
      // Take exactly `len` characters, skipping spaces, so trailing words are not swallowed.
      let count = 0;
      let i = 0;
      for (; i < raw.length && count < len; i++) if (raw[i] !== ' ') count++;
      if (count < len) continue;
      const next = text[start + i];
      if (next !== undefined && /[A-Za-z0-9]/.test(next)) continue;
      const value = raw.slice(0, i);
      if (!ibanValid(value.replace(/ /g, ''))) continue;
      out.push({ type: 'IBAN', start, end: start + i, value, detector: 'iban' });
    }
    return out;
  },
};

const CARD_PREFIX = /^(?:4|5[1-5]|2[2-7]|3[0478]|35|6)/;
const CARD_LENGTHS_BY_PREFERENCE = [16, 15, 19, 18, 17, 14, 13];

const card: Detector = {
  name: 'card',
  type: 'CARD',
  priority: 80,
  find(text) {
    const out: Finding[] = [];
    for (const m of text.matchAll(/(?<!\d)\d(?:[ -]?\d){12,24}(?!\d)/g)) {
      const start = m.index ?? 0;
      const raw = m[0];
      // Candidate ends: after a digit that is followed by a separator or by the end of the run.
      const ends = new Map<number, number>(); // digit count -> end offset in raw
      let digits = 0;
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] === ' ' || raw[i] === '-') continue;
        digits++;
        const nx = raw[i + 1];
        if (nx === undefined || nx === ' ' || nx === '-') ends.set(digits, i + 1);
      }
      for (const len of CARD_LENGTHS_BY_PREFERENCE) {
        const end = ends.get(len);
        if (end === undefined) continue;
        const value = raw.slice(0, end);
        const num = digitsOnly(value);
        if (!CARD_PREFIX.test(num) || /^(\d)\1+$/.test(num) || !luhnValid(num)) continue;
        out.push({ type: 'CARD', start, end: start + end, value, detector: 'card' });
        break;
      }
    }
    return out;
  },
};

const email = regexDetector({
  name: 'email',
  type: 'EMAIL',
  priority: 70,
  pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
  // logo@2x.png is an asset name, not an address
  accept: (v) => !/\.(png|jpe?g|gif|svg|webp|avif|ico|js|mjs|ts|tsx|css|json|md|txt|pdf)$/i.test(v),
});

const ipv4 = regexDetector({
  name: 'ipv4',
  type: 'IP',
  priority: 50,
  pattern:
    /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.]*\d)/g,
  accept: (v) => !v.startsWith('127.') && v !== '0.0.0.0' && v !== '255.255.255.255',
});

const phoneDigitsOk = (v: string) => {
  const n = digitsOnly(v).length;
  return n >= 8 && n <= 15;
};

const phones: Detector[] = (
  [
    // +33 6 12 34 56 78, +49 681 302-0, +1 (415) 555-0132
    ['phone-international', /(?<![\w+])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,6}(?![\d])/g],
    // 06 12 34 56 78, 06.12.34.56.78, 0612345678
    ['phone-fr', /(?<![\d.])0[1-9](?:[ .-]?\d{2}){4}(?![\d])/g],
    // 0171 1234567
    ['phone-de-mobile', /(?<!\d)01[5-7]\d[ /-]?\d{6,8}(?!\d)/g],
    // 0681 302-0, 030/12345678
    ['phone-de-landline', /(?<![\d.])0\d{2,4}[ /]\d{3,8}(?:-\d{1,4})?(?![\d.])/g],
    // (415) 555-0132, 415-555-0132
    ['phone-us', /(?<!\d)\(?[2-9]\d{2}\)?[ .-][2-9]\d{2}[ .-]\d{4}(?!\d)/g],
  ] as const
).map(([name, pattern]) =>
  regexDetector({ name, type: 'PHONE', priority: 40, pattern, accept: phoneDigitsOk }),
);

/** Default rule set, in no particular order: overlaps are settled by priority, then length. */
export const DEFAULT_DETECTORS: readonly Detector[] = [
  privateKey,
  jwt,
  ...apiKeys,
  connectionStringPassword,
  iban,
  card,
  email,
  secretAssignment,
  secretInProse,
  ipv4,
  ...phones,
  highEntropyToken,
];
