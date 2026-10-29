# Veil for Codex CLI, Gemini CLI and Cursor

The same protection as [Veil for Claude Code](../claude-code), through each tool's own hooks: secrets and personal data stay on your machine, the agent works with placeholders such as `[API_KEY_1]`, and real values go back in when it runs a command or writes a file. Rules (`~/.veil/config.json`, the project's `.veil.json`), the vault (`~/.veil/vaults`) and the audit log are shared with the Claude Code plugin. `veil show`, `veil stats`, `veil forget` and `veil help` work as prompts in all three.

Every hook needs Node.js 18 or later on your `PATH`.

## Gemini CLI

```bash
gemini extensions install https://github.com/yannf13/veil
```

| Gemini CLI hook | What Veil does |
| --- | --- |
| `SessionStart` | Gives the agent the guide to placeholders. |
| `BeforeAgent` | Stops a message that contains secrets and shows you the masked version to send. It stops rather than masks because, with the default `auto` model, Gemini CLI first sends the message to a routing model, and that request skips `BeforeModel`. |
| `BeforeModel` | Masks the text of every main model request with the session's vault, as a second line of defence. |
| `BeforeTool` | Puts real values back into tool arguments. Refuses dumps and in-place shell edits of files holding hidden values. |
| `AfterTool` | Replaces a result that holds secrets with its masked version. Gemini CLI marks such a result as a tool error, so the masked text starts with "The tool ran". |

**Tested** with Gemini CLI 0.66, against a local stand-in for the Gemini API that records every request:

- Reading a file with an API key and an email, then saving the email to another file: 4 model requests, none with a real value; the new file held the real email.
- A message with an email in it: stopped, zero model requests.
- `veil help`: answered, zero model requests.

## Codex CLI

```bash
git clone https://github.com/yannf13/veil ~/.veil/src
node ~/.veil/src/packages/agents/install.mjs codex
```

Then open Codex and approve the new hooks under `/hooks`: Codex runs hooks only after you review them.

| Codex hook | What Veil does |
| --- | --- |
| `SessionStart` | Gives the agent the guide to placeholders. |
| `UserPromptSubmit` | Stops a prompt that contains secrets; the TUI shows the masked version to send. |
| `PreToolUse` | Puts real values back into shell commands, `apply_patch` patches and MCP arguments. Because the patch gets the real values before it is applied, the agent can edit a file it saw with placeholders. Refuses dumps and in-place shell edits of files holding hidden values. |
| `PostToolUse` | Codex can't replace a tool result, but it shows the model a blocked hook's reason instead of the result. Veil blocks results that hold secrets and puts the masked output in the reason. |

**Tested** with Codex CLI 0.165, against a local stand-in for the Responses API that records every request:

- `cat config.txt`, then `echo "[EMAIL_1]" > owner.txt`: 3 model requests, none with a real value; `owner.txt` held the real email.
- A prompt with an email in it, and `veil help`: stopped, zero model requests. `codex exec` prints only "UserPromptSubmit Blocked"; the TUI shows the message.

## Cursor

```bash
git clone https://github.com/yannf13/veil ~/.veil/src
node ~/.veil/src/packages/agents/install.mjs cursor            # all projects
node ~/.veil/src/packages/agents/install.mjs cursor --project  # this project only
```

Restart Cursor afterwards. Cursor's hooks can't change what a file read or a shell command returns, so Veil keeps those from the agent when they hold secrets, instead of masking them.

| Cursor hook | What Veil does |
| --- | --- |
| `sessionStart` | Gives the agent the guide. |
| `beforeSubmitPrompt` | Stops a prompt that contains secrets and shows you the masked version. |
| `beforeReadFile` | Refuses to give the agent a file that contains secrets. |
| `beforeShellExecution` | Refuses a command that names a file containing secrets, and dumps or in-place edits of files holding hidden values. |
| `preToolUse` | Puts real values back into tool arguments. |
| `postToolUse` | Masks MCP results, the only results Cursor lets hooks change. |

The three checks that can stop a secret are installed with `failClosed`: if Veil can't run, Cursor blocks the action instead of letting it through.

**Not yet run in Cursor**: built from Cursor's hook documentation (Oct 2026); Cursor is closed source and needs an account. The hook logic is unit-tested.

## Remove

```bash
node ~/.veil/src/packages/agents/install.mjs codex --uninstall
node ~/.veil/src/packages/agents/install.mjs cursor --uninstall
gemini extensions uninstall veil
```

## Development

```bash
npm test -w @veil/agents   # builds dist/veil-agent.mjs, then runs the unit tests
```

`dist/veil-agent.mjs` is committed: the Gemini extension and the install script run it straight from a git checkout.
