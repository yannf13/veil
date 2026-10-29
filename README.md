# Veil

One local privacy layer for every AI tool. Veil masks secrets and personal data on your device before anything reaches an AI, then puts the real values back into the answer.

| Package | What it is | Status |
| --- | --- | --- |
| [`packages/engine`](packages/engine) | Detection, masking, restoring, rules and a values-free audit log; zero dependencies | v0.2, 147 tests |
| [`packages/extension`](packages/extension) | Chrome extension for ChatGPT, Claude and Gemini: masks on send, real values shown only in frames the site can't read, Veil window, Undo, toolbar popup with your rules, Chrome policy for organizations | v0.4, 37 end-to-end tests in Chromium; [install](packages/extension/README.md) |
| [`packages/claude-code`](packages/claude-code) | Claude Code plugin: masks what tools return, restores values when files are written or commands run, shows you real values in replies, refuses byte dumps and in-place edits of files with hidden values, stops typed prompts with secrets | v0.2, 42 unit tests + runs in real Claude Code; `/plugin marketplace add yannf13/veil` |
| [`packages/agents`](packages/agents) | Codex CLI, Gemini CLI and Cursor, through each tool's hooks | v0.1, 13 unit tests; Codex and Gemini CLI run end to end against local stand-ins for their APIs; [install](packages/agents/README.md) |

One set of rules for all of them: `~/.veil/config.json` (yours) and `.veil.json` in a repository (your team's) for the agents, the popup and Chrome policy for the extension. Same format everywhere: kinds to leave alone, values that stay visible, extra patterns to hide.

## packages/engine

Zero runtime dependencies, so the same code runs in a browser extension and in Node-based agent hooks.

```ts
import { compilePolicy, mask, restore, Vault } from '@veil/engine';

const vault = new Vault(); // one per conversation, never leaves the device
const { text } = mask('Mail jane.doe@example.org, IBAN DE89 3704 0044 0532 0130 00', { vault });
// text === 'Mail [EMAIL_1], IBAN [IBAN_1]'  -> safe to send

restore('I wrote to [EMAIL_1].', vault);
// 'I wrote to jane.doe@example.org.'

// Your rules on top of the built-ins; mistakes come back in policy.problems, never thrown.
const policy = compilePolicy({ disabled: ['NAME'], allow: ['*@acme.com'], patterns: [{ type: 'TICKET', pattern: 'SEC-\\d+' }] });
mask('SEC-42 from bob@acme.com', { vault, ...policy.options }).text;
// '[TICKET_1] from bob@acme.com'
```

**What it finds**

| Kind | How |
| --- | --- |
| API keys | Known formats: Anthropic, OpenAI, Stripe, GitHub, GitLab, AWS, Google, Slack, Hugging Face |
| Private keys, JWTs | Block and token shape |
| Secrets | Passwords in connection strings, values assigned to secret-named keys (quoted, or in .env and YAML style), passwords written in prose (EN, FR, DE), unknown random-looking tokens |
| IBANs | Country length + mod-97 checksum |
| Payment cards | Issuer prefix + Luhn checksum |
| Emails, phones, IPv4 | Patterns; phones for international, FR, DE and US formats |
| Names | A known first name followed by a surname, or any name after a title, greeting, sign-off, "my name is" or a form label; 6,700 first names from 12 locales |
| Postal addresses | French, German, US and UK formats, PO boxes |

False positives are measured on 47 MB of ordinary code, docs and licenses (`scripts/false-positives.ts`): code expressions, variable names, versions, paths, URL paths, section numbers, OIDs, byte lists and documentation IP ranges are left alone. A small on-device model for names in more languages is compared in the concept doc; none is shipped.

**Design choices**

- Overlapping findings are settled by rule priority, then length, so a whole API key wins over a fragment of it.
- The same value always gets the same placeholder within a vault, so the AI can still reason about "[EMAIL_1]" across messages.
- `restore` also accepts markdown-escaped placeholders such as `\[EMAIL\_1\]`, which chat UIs often produce.
- When in doubt between leaking and over-masking, the engine over-masks: a masked value is always restored locally.
- Known limit: if your own text already contains a literal like `[EMAIL_1]`, restore will replace it when the vault has that placeholder.

## Commands

```bash
npm install
npm test         # all packages: engine, extension end-to-end (needs Playwright's Chromium), Claude Code, agents
npm run build    # engine to dist/, extension to packages/extension/dist, the two hook bundles
npm run demo     # masks a sample prompt and restores a sample answer
npm run typecheck
```

Test secrets are assembled at runtime from a fake alphabet, so no real-looking key is committed and secret scanners stay quiet.

## License

[MIT](LICENSE): use, change and share it freely, including commercially, as long as the copyright notice stays.
