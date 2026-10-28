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
4. **You see real values; the site never does.** Your sent message and the AI's answer keep their placeholders in the page. Veil draws the real values over them from its own frame, which the site's scripts can't read. Message boxes are never touched.
5. **The Veil window.** As soon as a message is masked, a small window in the bottom-right corner lists each hidden value on the page next to its placeholder, with a **Copy** button. It can be minimized to a one-line pill. It moves up whenever it would cover the message box, and stays hidden on pages with no hidden values.

The vault (placeholder ↔ value) is one per site, shared by its tabs, and kept in `chrome.storage.session`: memory only, never written to disk, cleared when the browser closes.

## How real values are shown without the page seeing them

| Piece | Runs in | Knows real values? |
| --- | --- | --- |
| The AI site's page and scripts | the site's origin | No. It only ever holds placeholders. |
| Veil's content script | an isolated world the page can't reach | Yes, to mask and to measure widths |
| Veil's overlay frame (`overlay.html`) | the extension's own origin; cross-origin, so the page can't read it | Yes, read straight from session storage |
| The Veil window (`panel.html`) | the extension's own origin, like the overlay | Yes, read straight from session storage |

- The content script pads each placeholder with blank, non-breaking spaces to the width of its value, so the line has room for it. It then sends the overlay **positions and styles only, never values**, and sends the window only **the names of the placeholders on the page**. The window sends back only its height.
- The overlay draws each value over its placeholder, matching font, colour and background.
- It follows scrolling and resizing, stays inside scrolling areas, and hides a value when a menu or dialog covers it.
- The overlay accepts messages only from its parent page and only for that site's own vault.

## Tested

`npm test -w @veil/extension` loads the built extension into Chromium (Playwright) and drives stand-in chat pages served at the real addresses. The pages use the same editors as the sites: ProseMirror (ChatGPT, Claude), Quill (Gemini), and the plain textarea logged-out ChatGPT showed in Oct 2026. 22 tests:

- **Masking:** Enter, send button, clean messages, and two tabs sharing a vault.
- **Protected display:**
  - no real value anywhere in the page's text or HTML
  - the page can't read the overlay
  - values sit exactly over their placeholders
  - values follow scrolling and hide when covered
  - message boxes are never padded
- **Veil window:**
  - lists the values right after masking
  - Copy puts the value on the clipboard
  - minimizes and reopens
  - the page can't read it
  - it never covers the message box
  - it stays hidden when there is nothing to show

Also checked by hand on live chatgpt.com (logged out, Oct 2026): Veil stopped the send and masked the box.

## Known limits

- **Names and postal addresses** are not detected yet (needs the on-device model).
- **Width is visible.** The padding tells the page roughly how wide a value is, nothing else about it.
- **Copying from the page gives placeholders.** Selecting text, or a site's own copy button, copies the masked text. Use Copy in the Veil window for real values.
- **Long values** wider than their line are shortened with "…" on screen; the Veil window shows them in full on hover and copies them in full.
- **Fonts.** The overlay can't use a site's own web fonts, so a value may look slightly different from the text around it; it shrinks a little before shortening.
- **Screen readers** hear the placeholders: the overlay is hidden from assistive technology so it isn't read twice.
- **Detectable.** Sites can tell Veil is installed, because the overlay frame is a resource they can see load.
- **After a browser restart** older conversations show placeholders, since the vault is cleared on purpose.
- **Redesigns.** Each site has specific selectors plus generic fallbacks (a message box inside a form, that form's submit button). If a redesign hides the message box from all of them, Veil does nothing on that page.
