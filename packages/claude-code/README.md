# Veil for Claude Code

Keeps secrets and personal data out of Claude Code's model context while the agent works. Everything runs on your machine.

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
| A session starts | Tells the agent what placeholders are: use them as-is, never try to recover them, change files that show them with Write. |
| You type a prompt with a secret in it | Blocks it before the model sees anything and shows you the masked version to send instead. Hooks can't rewrite a prompt (checked in Claude Code 2.1.312). |
| A tool returns something (file contents, command output, web pages, MCP results) | Replaces each sensitive value with a placeholder such as `[API_KEY_1]` before the agent sees it. Only string values change, so each tool's output keeps the shape Claude Code requires. |
| The agent writes a file or runs a command | Swaps placeholders back for the real values just before the tool runs, so `.env` files and `curl` commands get the real thing. |
| The session ends | Deletes the session's vault. |

The vault (placeholder ↔ value) is one file per session in your temp folder, readable only by you (mode 600), and deleted when the session ends. Set `VEIL_VAULT_DIR` to keep it elsewhere.

## Tested in real Claude Code

Checked with `claude -p --plugin-dir` (Claude Code 2.1.312, Haiku). Results:

- **Reading `config.txt` with `cat` or Read:** the agent saw only `OPENAI_API_KEY=[API_KEY_1]` and `OWNER=[EMAIL_1]`.
- **Writing a placeholder:** `echo "[EMAIL_1]" > owner.txt` and Write both put the real value on disk.
- **Changing a line next to a secret:** done with Write, keeping the placeholders. The real key on the other line stayed intact.
- **A typed prompt containing an API key:** blocked; zero model turns, nothing created.
- **Leak check:** no record Claude Code sent to the model contained a real value. This covers messages, tool results and attachments.

## Known limits

- **Edits made by shell commands.** When a file the agent has read is changed by a shell command (`sed -i`, a formatter, a script), Claude Code itself shows the agent the changed lines, plus a few lines around them, unmasked. This happens outside any hook, so Veil can't mask it.
  - Claude Code already withholds those snippets for key and certificate files (`.pem`, `.key`, `id_rsa`, …) and `secrets.yml/json/toml`.
  - Veil tells the agent to change files that show placeholders with Write instead. In testing, the agent then stayed clear of this.
- **Determined decoding.** Before the session-start guide existed, an agent that took placeholders for mistakes dumped a file's bytes (`od -c`) and read a value back. The guide stopped that in testing. Veil guards against accidental exposure, not an agent set on decoding files.
- **The local transcript.** Claude Code logs the output of Veil's pre-tool hook, which contains the restored value, in your local transcript (`~/.claude/projects`). Claude Code never sends that record to the model (checked in its code). It stays on your disk, like the file that received the value.
- **Edit and placeholders.** Edit can't match text that contains a placeholder, because Claude Code checks the edit against the real file before any hook runs. The agent is told to use Write for such changes.
- **Answers show placeholders.** The agent's replies in your terminal show placeholders, not real values. There is no hook for the displayed reply.
- **Names and postal addresses** are not detected yet.

## Development

```bash
npm test -w @veil/claude-code    # builds dist/veil-hook.mjs, then runs the unit tests
```

`dist/veil-hook.mjs` is committed on purpose: Claude Code installs plugins straight from git, with no build step.
