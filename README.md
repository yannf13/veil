# Veil

One local privacy layer for every AI tool. Veil masks secrets and personal data on your device before anything reaches an AI, then puts the real values back into the answer.

This repo starts with the shared engine. The browser extension and the coding-agent plugins will be built on top of it.

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
npm test         # unit + realistic false-positive tests
npm run demo     # masks a sample prompt and restores a sample answer
npm run typecheck
```

Test secrets are assembled at runtime from a fake alphabet, so no real-looking key is committed and secret scanners stay quiet.
