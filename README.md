# Veil

One local privacy layer for every AI tool. Veil masks secrets and personal data on your device before anything reaches an AI, then puts the real values back into the answer.

| Package | What it is | Status |
| --- | --- | --- |
| [`packages/engine`](packages/engine) | Detection, masking and restoring; zero dependencies | v0.1, 61 tests |
| [`packages/extension`](packages/extension) | Chrome extension for ChatGPT, Claude and Gemini; real values shown only in frames the site can't read, plus a Veil window with Copy buttons | v0.3, 22 end-to-end tests in Chromium; [install](packages/extension/README.md) |
| [`packages/claude-code`](packages/claude-code) | Claude Code plugin: masks what tools return, restores values when files are written or commands run, blocks typed prompts with secrets | v0.1, 11 unit tests + runs in real Claude Code; install with `/plugin marketplace add yannf13/veil` |
| Other coding agents | Codex, Cursor, Gemini CLI | Next |

**Claude Code hooks, checked in version 2.1.312 (Oct 2026):** a `UserPromptSubmit` hook can block a typed prompt but cannot rewrite it. Tool hooks can rewrite: `PostToolUse` → `updatedToolOutput` replaces what the agent reads from any tool (same shape as the tool's output), and `PreToolUse` → `updatedInput` changes tool input before it runs. Details and the limits found in real runs are in the [plugin README](packages/claude-code/README.md).

## packages/engine

Zero runtime dependencies, so the same code runs in a browser extension and in Node-based agent hooks.

```ts
import { mask, restore, Vault } from '@veil/engine';

const vault = new Vault(); // one per conversation, never leaves the device
const { text } = mask('Mail jane.doe@example.org, IBAN DE89 3704 0044 0532 0130 00', { vault });
// text === 'Mail [EMAIL_1], IBAN [IBAN_1]'  -> safe to send

restore('I wrote to [EMAIL_1].', vault);
// 'I wrote to jane.doe@example.org.'
```

**What it finds today**

| Kind | How |
| --- | --- |
| API keys | Known formats: Anthropic, OpenAI, Stripe, GitHub, GitLab, AWS, Google, Slack, Hugging Face |
| Private keys, JWTs | Block and token shape |
| Secrets | Passwords in connection strings, values assigned to secret-named keys, passwords written in prose (EN, FR, DE), unknown high-entropy tokens |
| IBANs | Country length + mod-97 checksum |
| Payment cards | Issuer prefix + Luhn checksum |
| Emails, phones, IPv4 | Patterns; phones for international, FR, DE and US formats |

**Not yet:** names, postal addresses and other free-text personal data. Those need the small on-device model (next step). The vault is in memory only; encryption at rest comes with the browser extension.

**Design choices**

- Overlapping findings are settled by rule priority, then length, so a whole API key wins over a fragment of it.
- The same value always gets the same placeholder within a vault, so the AI can still reason about "[EMAIL_1]" across messages.
- `restore` also accepts markdown-escaped placeholders such as `\[EMAIL\_1\]`, which chat UIs often produce.
- When in doubt between leaking and over-masking, the engine over-masks: a masked value is always restored locally.
- Known limit: if your own text already contains a literal like `[EMAIL_1]`, restore will replace it when the vault has that placeholder.

## Commands

```bash
npm install
npm test         # engine tests + extension end-to-end tests (needs Playwright's Chromium)
npm run build    # engine to dist/, extension to packages/extension/dist
npm run demo     # masks a sample prompt and restores a sample answer
npm run typecheck
```

Test secrets are assembled at runtime from a fake alphabet, so no real-looking key is committed and secret scanners stay quiet.
