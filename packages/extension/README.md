# Veil browser extension

Chrome extension (Manifest V3) for ChatGPT, Claude and Gemini on the web, built on `@veil/engine`.

## Install (developer mode)

```bash
npm install
npm run build -w @veil/extension   # writes packages/extension/dist
```

Then in Chrome: `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick `packages/extension/dist`.

## What it does

1. **You press Enter or click send.** Veil scans the message box. Nothing sensitive: the message goes through untouched.
2. **Something sensitive.** Veil stops the send, swaps each value for a placeholder such as `[EMAIL_1]` right in the box, and shows a notice. Look at the message, then send again. You always see exactly what leaves your device.
3. **Fail closed.** If a value can't be replaced, nothing is sent and the notice turns red.
4. **Restore.** Placeholders in your sent message and in the AI's answer are swapped back to the real values on your screen. Message boxes are never restored, so real values can't slip into the next message.

The vault (placeholder ↔ value) is one per site, shared by its tabs, and kept in `chrome.storage.session`: memory only, never written to disk, cleared when the browser closes.

## Tested

`npm test -w @veil/extension` loads the built extension into Chromium (Playwright) and drives stand-in chat pages served at the real addresses, with the same editors the sites use: ProseMirror (ChatGPT, Claude), Quill (Gemini), and the plain textarea logged-out ChatGPT showed in Oct 2026. 13 tests: Enter, send button, clean messages, two tabs sharing a vault.

Also checked by hand on live chatgpt.com (logged out, Oct 2026): Veil stopped the send and masked the box. Claude and Gemini selectors are not yet checked on the live sites.

## Known limits

- **Names and postal addresses** are not detected yet (needs the on-device model).
- **Restored values are visible to the page.** Putting real values back on screen means the site's own scripts could read them from the page. An overlay the page can't read is the safer design, at some cost in polish.
- **Copy buttons** in the sites' UI copy the masked text; selecting and copying by hand gets the real values.
- **After a browser restart** older conversations show placeholders, since the vault is cleared on purpose.
- **Redesigns.** Each site has specific selectors plus generic fallbacks (a message box inside a form, that form's submit button). If a redesign hides the message box from all of them, Veil does nothing on that page.
