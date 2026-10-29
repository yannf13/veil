# Veil for Claude Code

Keeps secrets and personal data out of Claude Code's model context while the agent works. You still see the real values in the agent's replies. Everything runs on your machine.

## Install

In Claude Code:

```
/plugin marketplace add yannf13/veil
/plugin install veil@veil
```

Restart Claude Code (or start a new session) so the hooks load.

## What it does

| When | What Veil does |
| --- | --- |
| A session starts | Tells the agent what placeholders are: use them as-is, never try to recover them, change files that show them with Write. Reports mistakes in your rules. |
| You type a prompt with a secret in it | Blocks it before the model sees anything and shows you the masked version to send instead. Hooks can't rewrite a prompt (checked in Claude Code 2.1.312). |
| A tool returns something (file contents, command output, web pages, MCP results) | Replaces each sensitive value with a placeholder such as `[API_KEY_1]` before the agent sees it. Only string values change, so each tool's output keeps the shape Claude Code requires. Output that shows a hidden value in another form (hex dump, base64, one character per column, reversed, character codes) is withheld. |
| The agent writes a file or runs a command | Swaps placeholders back for the real values just before the tool runs, so `.env` files and `curl` commands get the real thing. |
| The agent tries to dump or edit in place a file that holds hidden values | Refuses (`od`, `xxd`, `base64`, `cut -c`, `sed -i`, `>>`, `tee` …) and tells the agent why. Other files are not affected. |
| The agent replies | Your screen shows the real values; the model and the stored conversation keep the placeholders (Claude Code's `MessageDisplay` hook). |

Detected: API keys (OpenAI, Anthropic, Stripe, GitHub, GitLab, AWS, Google, Slack, Hugging Face), private keys, JWTs, passwords in config and prose, random-looking tokens, email addresses, phone numbers, IBANs, card numbers, IP addresses, names and postal addresses.

## Commands

Type these instead of a prompt. Veil answers them itself; the model never sees them.

| Command | What it does |
| --- | --- |
| `veil show` or `/veil:show` | Lists the hidden values of this session with their placeholders. |
| `veil stats` or `/veil:stats` | What Veil kept from the model in the last 7 and 30 days, as counts. |
| `veil forget` or `/veil:forget` | Deletes this session's hidden values now. |
| `veil help` or `/veil:help` | How it works, where the rules live, and any problems in them. |

## Rules

Three optional files, same format, and they add up:

- `~/.veil/config.json`: yours.
- `.veil.json` in the project (looked up from the working directory to the repository root): your team's, committed with the code.
- `/etc/veil/config.json` (or `VEIL_MANAGED_CONFIG`): the machine's, for managed laptops.

```json
{
  "disabled": ["NAME"],
  "allow": ["support@yourcompany.com", "*@example.com", "/^10\\.0\\./"],
  "patterns": [
    { "type": "TICKET", "pattern": "SEC-\\d+", "label": ["ticket", "tickets"] },
    { "type": "CUSTOMER_ID", "pattern": "cust(?:omer)?[ #:]+(\\d{6})", "flags": "i", "group": 1 }
  ],
  "showRealValues": true
}
```

- `disabled`: kinds to leave alone (`EMAIL`, `PHONE`, `IBAN`, `CARD`, `IP`, `API_KEY`, `PRIVATE_KEY`, `JWT`, `SECRET`, `NAME`, `ADDRESS`).
- `allow`: values that stay visible: exact text (any case), a wildcard, or a regular expression between slashes.
- `patterns`: extra things to hide, each with its own placeholder name.
- `showRealValues`: `false` keeps placeholders on your screen too.

## Where things are kept

- **The vault** (placeholder ↔ value): one file per session in `~/.veil/vaults`, readable only by you (mode 600). It outlives the session so `claude --resume` keeps working, and is deleted after 30 days without use, or at once with `veil forget`. Set `VEIL_VAULT_DIR` to keep it elsewhere.
- **The audit log** (`~/.veil/audit.json`): counts per kind and per day. It never holds a value.

## Tested in real Claude Code

Checked with `claude -p --plugin-dir` (Claude Code 2.1.312, Haiku). Results:

- **Reading `config.txt`:** the agent saw only `OPENAI_API_KEY=[API_KEY_1]` and `OWNER=[EMAIL_1]`. Its reply was stored with the placeholders and shown with the real values.
- **Writing a placeholder:** `echo "[EMAIL_1]" > owner.txt` and Write both put the real value on disk.
- **Changing a file with secrets, asked to use `sed -i`:** the agent used Write instead, keeping the placeholders. The real key stayed intact on disk.
- **`xxd config.txt`:** refused by Veil; the command never ran.
- **`veil show` and `/veil:show`:** zero model turns. Asked in the next turn to quote any `sk-proj-` string it had seen, the model said it had seen none.
- **A typed prompt containing an API key:** blocked; zero model turns.
- **Leak check:** no record Claude Code sent to the model contained a real value. This covers messages, tool results and attachments.

## Known limits

- **Edits made by other programs.** When a file the agent has read is changed by something other than Claude Code's own tools (a formatter, a script, `git checkout`), Claude Code itself shows the agent the changed lines, plus a few lines around them, unmasked. This happens outside any hook.
  - Veil refuses the common in-place edit commands on files holding hidden values, and tells the agent to use Write.
  - Claude Code already withholds those snippets for key and certificate files (`.pem`, `.key`, `id_rsa`, …) and `secrets.yml/json/toml`.
- **Determined decoding.** Veil guards against accidental exposure, not an agent set on decoding files: it can refuse and withhold the common dumps, not every possible encoding.
- **The local transcript.** Claude Code logs, in your local transcript (`~/.claude/projects`), the output of Veil's pre-tool hook (which holds the restored values) and the `veil show` list. Claude Code never sends those records to the model (checked in its code and in testing). They stay on your disk, like the files that hold the values.
- **Edit and placeholders.** Edit can't match text that contains a placeholder, because Claude Code checks the edit against the real file before any hook runs. The agent is told to use Write for such changes.
- **Replies that talk about placeholders.** Your screen shows the real value wherever the reply has a placeholder, even in a sentence such as "the placeholder [API_KEY_1]".

## Development

```bash
npm test -w @veil/claude-code    # builds dist/veil-hook.mjs, then runs the unit tests
```

`dist/veil-hook.mjs` is committed on purpose: Claude Code installs plugins straight from git, with no build step.
