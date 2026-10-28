// Built from packages/claude-code/src/hook.ts by build.mjs. Do not edit.

// ../engine/src/validators.ts
function luhnValid(digits) {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
var IBAN_LENGTHS = {
  AD: 24,
  AE: 23,
  AL: 28,
  AT: 20,
  AZ: 28,
  BA: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BR: 29,
  CH: 21,
  CR: 22,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  DO: 28,
  EE: 20,
  EG: 29,
  ES: 24,
  FI: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GE: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  GT: 28,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IS: 26,
  IT: 27,
  JO: 30,
  KW: 30,
  KZ: 20,
  LB: 28,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MR: 27,
  MT: 31,
  MU: 30,
  NL: 18,
  NO: 15,
  PK: 24,
  PL: 28,
  PS: 29,
  PT: 25,
  QA: 29,
  RO: 24,
  RS: 22,
  SA: 24,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  TN: 24,
  TR: 26,
  UA: 29,
  VG: 24,
  XK: 20
};
function ibanValid(compact) {
  const iban2 = compact.toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban2)) return false;
  const expected = IBAN_LENGTHS[iban2.slice(0, 2)];
  if (expected === void 0 || iban2.length !== expected) return false;
  const rearranged = iban2.slice(4) + iban2.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const digits = code >= 65 ? String(code - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}
function shannonEntropy(s) {
  if (s.length === 0) return 0;
  const counts = /* @__PURE__ */ new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}
function alnumClassCount(s) {
  return Number(/[a-z]/.test(s)) + Number(/[A-Z]/.test(s)) + Number(/\d/.test(s));
}
function digitsOnly(s) {
  return s.replace(/\D/g, "");
}

// ../engine/src/detectors.ts
function regexDetector(rule) {
  return {
    name: rule.name,
    type: rule.type,
    priority: rule.priority,
    find(text) {
      const out = [];
      for (const m of text.matchAll(rule.pattern)) {
        let start;
        let value;
        if (rule.group !== void 0) {
          const span = m.indices?.[rule.group];
          const v = m[rule.group];
          if (!span || v === void 0) continue;
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
    }
  };
}
var privateKey = regexDetector({
  name: "private-key-block",
  type: "PRIVATE_KEY",
  priority: 100,
  pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g
});
var jwt = regexDetector({
  name: "jwt",
  type: "JWT",
  priority: 95,
  pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
});
var apiKeyRules = [
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9]{2,12}-[A-Za-z0-9_-]{20,}/g],
  [
    "openai-key",
    /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
    // Rules out long lowercase slugs such as "sk-learn-style-long-identifier".
    (v) => /\d/.test(v) && alnumClassCount(v) >= 2
  ],
  ["stripe-key", /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["huggingface-token", /\bhf_[A-Za-z0-9]{30,}\b/g]
];
var apiKeys = apiKeyRules.map(
  ([name, pattern, accept]) => regexDetector({ name, type: "API_KEY", priority: 90, pattern, ...accept ? { accept } : {} })
);
var connectionStringPassword = regexDetector({
  name: "connection-string-password",
  type: "SECRET",
  priority: 85,
  pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]+)@/gid,
  group: 1
});
function looksLikeRealSecret(v) {
  if (/^(true|false|null|none|nil|undefined|required|optional|string|number|boolean|secret|password)$/i.test(v)) return false;
  if (/^[$<{%[]/.test(v)) return false;
  if (/[()]/.test(v)) return false;
  if (/^(process\.env|os\.environ|env\.|import\.meta)/.test(v)) return false;
  if (/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/.test(v)) return false;
  if (/^(.)\1+$/.test(v)) return false;
  if (/^your[_-]/i.test(v)) return false;
  return true;
}
var secretAssignment = regexDetector({
  name: "secret-assignment",
  type: "SECRET",
  priority: 60,
  pattern: /\b[A-Za-z0-9_.-]*?(?:password|passwd|passwort|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*(["']?)([^\s"'`,;]{6,})\1/gid,
  group: 2,
  accept: looksLikeRealSecret
});
var secretInProse = regexDetector({
  name: "password-in-prose",
  type: "SECRET",
  priority: 60,
  pattern: /\b(?:password|passwort|kennwort|mot de passe|mdp)\s*(?:is|ist|est)?\s*[:=]?\s*["']?([^\s"',;]{6,})/gid,
  group: 1,
  accept: (v) => {
    const core = v.replace(/[.!?:)]+$/, "");
    return /[\d\W_]/.test(core) && looksLikeRealSecret(core);
  }
});
var highEntropyToken = regexDetector({
  name: "high-entropy-token",
  type: "SECRET",
  priority: 10,
  pattern: /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{24,}(?![A-Za-z0-9+/_=-])/g,
  accept: (v) => {
    if (alnumClassCount(v) < 3) return false;
    if (/^[0-9a-f-]+$/i.test(v)) return false;
    if (/^sha(256|384|512)-/.test(v)) return false;
    return shannonEntropy(v) >= 4.2;
  }
});
var iban = {
  name: "iban",
  type: "IBAN",
  priority: 80,
  find(text) {
    const out = [];
    for (const m of text.matchAll(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,32}/gi)) {
      const start = m.index ?? 0;
      const raw = m[0];
      const len = IBAN_LENGTHS[raw.slice(0, 2).toUpperCase()];
      if (len === void 0) continue;
      let count = 0;
      let i = 0;
      for (; i < raw.length && count < len; i++) if (raw[i] !== " ") count++;
      if (count < len) continue;
      const next = text[start + i];
      if (next !== void 0 && /[A-Za-z0-9]/.test(next)) continue;
      const value = raw.slice(0, i);
      if (!ibanValid(value.replace(/ /g, ""))) continue;
      out.push({ type: "IBAN", start, end: start + i, value, detector: "iban" });
    }
    return out;
  }
};
var CARD_PREFIX = /^(?:4|5[1-5]|2[2-7]|3[0478]|35|6)/;
var CARD_LENGTHS_BY_PREFERENCE = [16, 15, 19, 18, 17, 14, 13];
var card = {
  name: "card",
  type: "CARD",
  priority: 80,
  find(text) {
    const out = [];
    for (const m of text.matchAll(/(?<!\d)\d(?:[ -]?\d){12,24}(?!\d)/g)) {
      const start = m.index ?? 0;
      const raw = m[0];
      const ends = /* @__PURE__ */ new Map();
      let digits = 0;
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] === " " || raw[i] === "-") continue;
        digits++;
        const nx = raw[i + 1];
        if (nx === void 0 || nx === " " || nx === "-") ends.set(digits, i + 1);
      }
      for (const len of CARD_LENGTHS_BY_PREFERENCE) {
        const end = ends.get(len);
        if (end === void 0) continue;
        const value = raw.slice(0, end);
        const num = digitsOnly(value);
        if (!CARD_PREFIX.test(num) || /^(\d)\1+$/.test(num) || !luhnValid(num)) continue;
        out.push({ type: "CARD", start, end: start + end, value, detector: "card" });
        break;
      }
    }
    return out;
  }
};
var email = regexDetector({
  name: "email",
  type: "EMAIL",
  priority: 70,
  pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
  // logo@2x.png is an asset name, not an address
  accept: (v) => !/\.(png|jpe?g|gif|svg|webp|avif|ico|js|mjs|ts|tsx|css|json|md|txt|pdf)$/i.test(v)
});
var ipv4 = regexDetector({
  name: "ipv4",
  type: "IP",
  priority: 50,
  pattern: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.]*\d)/g,
  accept: (v) => !v.startsWith("127.") && v !== "0.0.0.0" && v !== "255.255.255.255"
});
var phoneDigitsOk = (v) => {
  const n = digitsOnly(v).length;
  return n >= 8 && n <= 15;
};
var phones = [
  // +33 6 12 34 56 78, +49 681 302-0, +1 (415) 555-0132
  ["phone-international", /(?<![\w+])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,6}(?![\d])/g],
  // 06 12 34 56 78, 06.12.34.56.78, 0612345678
  ["phone-fr", /(?<![\d.])0[1-9](?:[ .-]?\d{2}){4}(?![\d])/g],
  // 0171 1234567
  ["phone-de-mobile", /(?<!\d)01[5-7]\d[ /-]?\d{6,8}(?!\d)/g],
  // 0681 302-0, 030/12345678
  ["phone-de-landline", /(?<![\d.])0\d{2,4}[ /]\d{3,8}(?:-\d{1,4})?(?![\d.])/g],
  // (415) 555-0132, 415-555-0132
  ["phone-us", /(?<!\d)\(?[2-9]\d{2}\)?[ .-][2-9]\d{2}[ .-]\d{4}(?!\d)/g]
].map(
  ([name, pattern]) => regexDetector({ name, type: "PHONE", priority: 40, pattern, accept: phoneDigitsOk })
);
var DEFAULT_DETECTORS = [
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
  highEntropyToken
];

// ../engine/src/engine.ts
function detect(text, options = {}) {
  const detectors = (options.detectors ?? DEFAULT_DETECTORS).filter(
    (d) => !options.types || options.types.includes(d.type)
  );
  const candidates = detectors.flatMap((d) => d.find(text).map((f) => ({ f, priority: d.priority })));
  candidates.sort(
    (a, b) => b.priority - a.priority || b.f.end - b.f.start - (a.f.end - a.f.start) || a.f.start - b.f.start
  );
  const chosen = [];
  for (const { f } of candidates) {
    if (!chosen.some((c) => f.start < c.end && c.start < f.end)) chosen.push(f);
  }
  return chosen.sort((a, b) => a.start - b.start);
}
var Vault = class _Vault {
  byKey = /* @__PURE__ */ new Map();
  byPlaceholder = /* @__PURE__ */ new Map();
  counters = /* @__PURE__ */ new Map();
  get size() {
    return this.byPlaceholder.size;
  }
  placeholderFor(type, value) {
    const key = `${type}\0${value}`;
    const existing = this.byKey.get(key);
    if (existing) return existing.placeholder;
    const n = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, n);
    const entry = { placeholder: `[${type}_${n}]`, type, value };
    this.byKey.set(key, entry);
    this.byPlaceholder.set(entry.placeholder, entry);
    return entry.placeholder;
  }
  valueOf(placeholder) {
    return this.byPlaceholder.get(placeholder)?.value;
  }
  entries() {
    return [...this.byPlaceholder.values()];
  }
  toJSON() {
    return this.entries();
  }
  static fromJSON(entries) {
    const vault = new _Vault();
    for (const e of entries) {
      const key = `${e.type}\0${e.value}`;
      vault.byKey.set(key, e);
      vault.byPlaceholder.set(e.placeholder, e);
      const n = Number(/_(\d+)\]$/.exec(e.placeholder)?.[1] ?? 0);
      vault.counters.set(e.type, Math.max(vault.counters.get(e.type) ?? 0, n));
    }
    return vault;
  }
};
function mask(text, options = {}) {
  const vault = options.vault ?? new Vault();
  const findings = detect(text, options);
  let out = "";
  let cursor = 0;
  for (const f of findings) {
    out += text.slice(cursor, f.start) + vault.placeholderFor(f.type, f.value);
    cursor = f.end;
  }
  out += text.slice(cursor);
  return { text: out, findings, vault };
}
var PLACEHOLDER = /\\?\[([A-Z]+(?:\\?_[A-Z]+)*)\\?_(\d+)\\?\]/g;
var normalize = (type, n) => `[${type.replace(/\\/g, "")}_${n}]`;
function restore(text, vault) {
  return text.replace(PLACEHOLDER, (match, type, n) => vault.valueOf(normalize(type, n)) ?? match);
}

// src/hook.ts
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
var AGENT_GUIDE = [
  "Veil is active in this session. It hides secrets and personal data from you: in tool results they appear as placeholders such as [EMAIL_1] or [API_KEY_2]. The user installed Veil on purpose.",
  "- Treat each placeholder as the value itself and use it as-is in files you write and commands you run. Veil puts the real value back just before a file is written or a command runs, then hides it again in the output. A placeholder is never a mistake to fix.",
  "- Don't try to recover hidden values (no hex or byte dumps, od, xxd, base64, character-by-character reads, or similar), and don't ask the user for them.",
  "- To change a file that shows placeholders, rewrite the whole file with the Write tool, keeping the placeholders. Don't use Edit on text that contains a placeholder (the file on disk holds the real value, so Edit can't match it), and don't change such files with shell commands such as sed -i or > redirects: Claude Code then shows you the changed lines without Veil's masking."
].join("\n");
var SKIP_KEYS = /* @__PURE__ */ new Set(["type", "filePath", "file_path", "path", "notebook_path", "base64", "media_type", "mimeType"]);
function vaultPath(sessionId) {
  const dir = process.env.VEIL_VAULT_DIR ?? join(tmpdir(), "veil-claude-code");
  return join(dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_") || "default"}.json`);
}
function loadVault(path) {
  try {
    return Vault.fromJSON(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return new Vault();
  }
}
function saveVault(path, vault) {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true, mode: 448 });
  writeFileSync(path, JSON.stringify(vault.toJSON()), { mode: 384 });
  chmodSync(path, 384);
}
function mapStrings(value, fn, key = "") {
  if (typeof value === "string") return SKIP_KEYS.has(key) ? value : fn(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const m = mapStrings(v, fn, key);
      if (m !== v) changed = true;
      return m;
    });
    return changed ? out : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const m = mapStrings(v, fn, k);
      if (m !== v) changed = true;
      out[k] = m;
    }
    return changed ? out : value;
  }
  return value;
}
var LABELS = {
  EMAIL: ["email address", "email addresses"],
  PHONE: ["phone number", "phone numbers"],
  IBAN: ["IBAN", "IBANs"],
  CARD: ["card number", "card numbers"],
  IP: ["IP address", "IP addresses"],
  API_KEY: ["API key", "API keys"],
  PRIVATE_KEY: ["private key", "private keys"],
  JWT: ["access token", "access tokens"],
  SECRET: ["password or secret", "passwords or secrets"]
};
function describe(findings) {
  const counts = /* @__PURE__ */ new Map();
  for (const f of findings) counts.set(f.type, (counts.get(f.type) ?? 0) + 1);
  const parts = [...counts].map(([t, n]) => `${n} ${LABELS[t][n === 1 ? 0 : 1]}`);
  return parts.length <= 1 ? parts[0] ?? "" : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
function run(mode, input) {
  const path = vaultPath(input.session_id ?? "default");
  switch (mode) {
    case "session-start":
      return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: AGENT_GUIDE } };
    case "user-prompt": {
      const prompt = input.prompt ?? "";
      if (detect(prompt).length === 0) return null;
      const vault = loadVault(path);
      const { text, findings } = mask(prompt, { vault });
      saveVault(path, vault);
      return {
        decision: "block",
        reason: `Veil stopped this prompt: it contains ${describe(findings)}. Nothing was sent.
Send this version instead; Veil puts the real values back whenever the agent writes a file or runs a command:

${text}`,
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true },
        suppressOutput: true
      };
    }
    case "post-tool": {
      if (input.tool_response === void 0) return null;
      const vault = loadVault(path);
      const before = vault.size;
      const masked = mapStrings(input.tool_response, (s) => mask(s, { vault }).text);
      if (masked === input.tool_response) return null;
      if (vault.size !== before) saveVault(path, vault);
      return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: masked }, suppressOutput: true };
    }
    case "pre-tool": {
      if (!existsSync(path)) return null;
      const vault = loadVault(path);
      if (vault.size === 0) return null;
      const restored = mapStrings(input.tool_input, (s) => restore(s, vault));
      if (restored === input.tool_input) return null;
      return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: restored }, suppressOutput: true };
    }
    case "session-end": {
      rmSync(path, { force: true });
      return null;
    }
  }
}
function main() {
  const mode = process.argv[2];
  if (!["session-start", "user-prompt", "pre-tool", "post-tool", "session-end"].includes(mode)) {
    process.stderr.write(`veil: unknown hook "${mode}"
`);
    process.exit(1);
  }
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    process.stderr.write("veil: could not read the hook input\n");
    process.exit(1);
  }
  try {
    const out = run(mode, input);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err) {
    process.stderr.write(`veil: ${mode} hook failed: ${err instanceof Error ? err.message : String(err)}
`);
    process.exit(1);
  }
}
if (process.argv[1] && /veil-hook\.(m?js|ts)$/.test(process.argv[1])) main();
export {
  AGENT_GUIDE,
  describe,
  mapStrings,
  run,
  vaultPath
};
