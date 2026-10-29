import { addresses, names } from './people.js';
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
  /** Extra check on the value; return false to drop the match. Gets the whole text and the value's offset. */
  accept?: (value: string, text: string, start: number) => boolean;
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
        if (rule.accept && !rule.accept(value, text, start)) continue;
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
  accept: (v) => looksLikeRealSecret(v),
});

/** Values that look assigned to a secret-named key but are references or placeholders, not secrets. */
function looksLikeRealSecret(v: string): boolean {
  if (/^(true|false|null|none|nil|undefined|required|optional|string|number|boolean|secret|password|bearer|basic|token|changeme)$/i.test(v)) return false;
  if (/^[$<{%[]/.test(v)) return false; // ${VAR}, <YOUR_KEY>, {{template}}, %s, [REDACTED]
  if (/[()]/.test(v)) return false; // function calls
  if (/^(process\.env|os\.environ|env\.|import\.meta)/.test(v)) return false;
  if (/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/.test(v)) return false; // config.apiKey
  if (/^(.)\1+$/.test(v)) return false; // ******** or xxxxxxxx
  if (/^your[_-]/i.test(v)) return false;
  // Identifiers and type names: `privateKey: CryptoKey`, `token = userToken`.
  if (/^(?:[A-Z][a-z]+){2,}$|^[a-z]+(?:[A-Z][a-z]+)+$/.test(v)) return false;
  if (/^(?:[a-z0-9]+[_-])*(?:token|password|passwd|secret|key|apikey)(?:[_-][a-z0-9]+)*$/i.test(v)) return false; // 'access_token', 'mock-token'
  if (/^[~^<>=v]*\d+(?:\.\d+)+/.test(v)) return false; // versions: "^1.0.0"
  if (/^(?:\/|~\/|\.{1,2}\/|[A-Za-z]:\\)/.test(v)) return false; // paths: PWD=/Users/jane
  return true;
}

/**
 * Share of a token made of pronounceable words (Canvas, Rendering, global, Alpha): a vowel and no
 * more than three consonants in a row. Random secrets score low; URL paths and identifiers such as
 * Web/API/CanvasRenderingContext2D/fillStyle score high.
 */
function wordiness(v: string): number {
  let covered = 0;
  for (const m of v.matchAll(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g)) {
    const w = m[0];
    if (w.length >= 3 && /[aeiouyAEIOUY]/.test(w) && !/[^aeiouyAEIOUY]{5}/.test(w)) covered += w.length;
  }
  return covered / v.length;
}

/** Random text gets close to log2(length) bits per character; short tokens can't reach a fixed bar. */
const entropyBar = (len: number): number => (len < 32 ? 3.8 : len < 48 ? 4.0 : 4.2);

const SECRET_KEY = String.raw`[A-Za-z0-9_.-]*?(?:password|passwd|passwort|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_-]*`;

/** Keys that name a property of a secret rather than hold one: token_type, password_hint, api_key_name. */
const META_KEY = /[_.-](?:type|types|name|names|kind|page|url|uri|endpoint|hint|header|field|param|prefix|suffix|format|len|length|size|count|path|file|dir|env|var|label|policy|min|max|expiry|expires|ttl|scope|scopes|id)$|(?:Type|Name|Kind|Url|Uri|Hint|Header|Field|Length|Size|Count|Path|File|Label|Id)$/;

/** Code expressions, not literal values: line[1], self.token, getToken(), a || b. */
const EXPRESSION = /[[\](){}<>|&*]|^[A-Za-z_$][\w$]*\.[A-Za-z_$]|^(?:self|this|cls|os|env|process|config|settings|options|opts|args|params|ctx|req|request|res|response)\b/;

/** Variable names: snake_case or camelCase, which code assigns far more often than literal secrets. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const identifierStyle = (v: string): boolean => IDENTIFIER.test(v) && (v.includes('_') || /[a-z][A-Z]/.test(v));

/**
 * API_KEY=..., "password": "...", client_secret: ... — masks the value only.
 * Quoted values count. Unquoted ones count in .env-style lines (KEY=value) or when they look
 * like a literal (no expression syntax, not a variable name), since code assigns variables far
 * more often than secrets: `token = line[1]`, `password = unquote(raw)`.
 */
const secretAssignment: Detector = {
  name: 'secret-assignment',
  type: 'SECRET',
  priority: 60,
  find(text) {
    const out: Finding[] = [];
    const rx = new RegExp(String.raw`\b(${SECRET_KEY})(["']?)[ \t]*[:=][ \t]*(?:(["'\`])([^"'\`\n]{6,}?)\3|([^\s"'\`,;]{6,}))`, 'gid');
    for (const m of text.matchAll(rx)) {
      const quoted = m[4];
      const bare = m[5];
      const value = quoted ?? bare;
      const span = m.indices?.[quoted !== undefined ? 4 : 5];
      if (!value || !span) continue;
      const key = m[1] ?? '';
      // token_type = 'mailbox', refresh_token_page = "+access-token": names of things, not secrets
      if (META_KEY.test(key)) continue;
      if (key.length >= 3 && value.toLowerCase().includes(key.toLowerCase())) continue; // 'spwd': 'spwd#module-spwd'
      if (quoted !== undefined) {
        if (/\s/.test(value.trim()) && !/[\d\W_]/.test(value.replace(/\s/g, ''))) continue; // a sentence, not a secret
        if (!looksLikeRealSecret(value)) continue;
      } else {
        const lineStart = text.lastIndexOf('\n', (m.index ?? 0) - 1) + 1;
        const lineEnd = text.indexOf('\n', span[1]);
        const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        const envStyle = /^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*=\S/.test(line); // .env files and shell exports
        const core = value.replace(/[.,!?:)]+$/, '');
        if (!looksLikeRealSecret(core) || EXPRESSION.test(core)) continue;
        if (!envStyle && (identifierStyle(core) || !/\d/.test(core) || alnumClassCount(core) < 2)) continue;
      }
      out.push({ type: 'SECRET', start: span[0], end: span[1], value, detector: 'secret-assignment' });
    }
    return out;
  },
};

/** "my password is Soleil2024!", "mot de passe : ...", "Passwort ist ..." — needs a digit or symbol to count. */
const secretInProse = regexDetector({
  name: 'password-in-prose',
  type: 'SECRET',
  priority: 60,
  pattern: /\b(?:password|passwort|kennwort|mot de passe|mdp)\b(?:[ \t]*[:=][ \t]*|[ \t]+(?:is|ist|est|was|war|lautet|c'est)[ \t]*[:=]?[ \t]*)["']?([^\s"',;]{6,})/gid,
  group: 1,
  accept: (v) => {
    // Sentence punctuation at the end ("is required.") doesn't make a word look like a password,
    // but it stays in the masked value: over-masking a full stop is harmless, leaking a "!" is not.
    const core = v.replace(/[.!?:)]+$/, '');
    return /[\d\W_]/.test(core) && looksLikeRealSecret(core) && !EXPRESSION.test(core) && !identifierStyle(core);
  },
});

/** Long random-looking tokens that no specific rule caught. Lowest priority. */
const highEntropyToken = regexDetector({
  name: 'high-entropy-token',
  type: 'SECRET',
  priority: 10,
  // "=" may only pad the end, so in "code_challenge=<token>" the token starts after the "=".
  pattern: /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{24,}={0,2}(?![A-Za-z0-9+/_=-])/g,
  accept: (v, text, start) => {
    const before = text.slice(Math.max(0, start - 300), start);
    if (/sha(?:1|224|256|384|512)["':= -]*$/i.test(before)) return false; // a labelled hash, public by design
    if (/(?:^|\s)\S*(?::\/\/|www\.)\S*$/.test(before) || /[A-Za-z0-9]\.$/.test(before)) {
      // Part of a URL or a dotted name: only a random segment (a webhook or signed-link key) is a secret.
      return v.split(/[/?&=#]/).some((seg) => seg.length >= 16 && randomLooking(seg));
    }
    return randomLooking(v);
  },
});

/**
 * Names joined by separators, every part short, a word, a number or hex: identifiers, file names and
 * timestamps. A generated secret has at least one long part that is none of these.
 */
function madeOfPlainParts(v: string): boolean {
  const parts = v.split(/[-_/.+=]+/).filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every((p) => p.length <= 5 || /^[0-9a-f]+$/.test(p) || /^\d+$/.test(p) || /^[A-Z]?[a-z]+$|^[A-Z]+$/.test(p));
}

/** Mixed-case, digit-bearing, high-entropy and not made of words: what generated credentials look like. */
function randomLooking(v: string): boolean {
  if (alnumClassCount(v) < 3) return false; // needs lower, upper and digits
  if (/abcdef|ABCDEF|012345|qwerty/.test(v)) return false; // alphabets and keyboard runs, not random
  if (madeOfPlainParts(v)) return false; // EVP_PKEY_CTX_set, NODE_SEA_FUSE_<hex>, page-2026-02-14T19-22-42-679Z
  if (/^[0-9a-f-]+$/i.test(v)) return false; // hashes, UUIDs
  if (/^sha(256|384|512)-/.test(v)) return false; // public integrity hashes in lockfiles and <script integrity>
  if (v.length > 512) return false; // inline images and other blobs, not credentials
  if (wordiness(v) >= 0.5) return false; // paths and identifiers, not random
  return shannonEntropy(v) >= entropyBar(v.length);
}

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
  accept: (v, text, start) => {
    const octets = v.split('.').map(Number);
    if (octets[0] === 127 || octets[0] === 0 || octets[0]! >= 224) return false; // loopback, "this network", multicast, broadcast
    if (octets.every((o) => o < 10)) return false; // 2.5.4.3, 8.6.1.5: section numbers and OIDs (and public resolvers like 1.1.1.1)
    const before = text.slice(Math.max(0, start - 40), start);
    if (/(?:\b(?:section|sect\.|rfc[ -]?\d+|chapter|version|release|v|ver\.?|oid)|§|ObjectIdentifier\(|\$)\s*["'`]?$/i.test(before)) return false;
    // Documentation ranges (RFC 5737, RFC 2544): examples by definition, never anyone's address.
    if (/^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./.test(v) || (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19))) return false;
    if (/^-[A-Za-z]/.test(text.slice(start + v.length, start + v.length + 2))) return false; // 11.3.244.8-node.9
    return true;
  },
});

const phoneDigitsOk = (v: string, text: string, start: number) => {
  const digits = digitsOnly(v);
  if (digits.length < 8 || digits.length > 15) return false;
  if (/^[01]+$/.test(digits)) return false; // binary: 0000 0001
  if (/^0?123456789|(\d)\1{5}/.test(digits)) return false; // digit alphabets and repeats are placeholders
  // Part of a longer run of two-digit groups: bytes such as <Buffer 04 03 02 01 08 07>
  const after = text.slice(start + v.length, start + v.length + 3);
  const before = text.slice(Math.max(0, start - 3), start);
  if (/^ [0-9a-f]{2}\b/i.test(after) || /\b[0-9a-f]{2} $/i.test(before)) return false;
  return true;
};

const phones: Detector[] = (
  [
    // +33 6 12 34 56 78, +49 681 302-0, +1 (415) 555-0132
    ['phone-international', /(?<![\w+])\+[1-9]\d{0,2}(?:[ .-]?\(?\d{1,4}\)?){2,6}(?![\d])/g],
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
  addresses,
  names,
  highEntropyToken,
];
