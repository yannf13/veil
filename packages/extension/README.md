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
6. **Undo.** The notice after masking has an **Undo** button: it puts your text back as you wrote it and lets that one message go unchanged. The next message is checked again.

## The toolbar popup

- **This page:** whether Veil is protecting it, how many hidden values are on it, and a switch to turn Veil off for the site.
- **Hidden in the last 30 days:** counts per kind, from a log that holds no values (`chrome.storage.local`).
- **What to hide:** one switch per kind: emails, phones, IBANs, cards, IPs, API keys, private keys, access tokens, passwords, names, postal addresses.
- **Your rules:** values that always stay visible (exact text, `*@yourcompany.com`, or `/regex/`) and extra patterns to hide (`PROJECT PRJ-\d{4}`), each with its own placeholder. Mistakes are explained, not saved.

Your settings live in `chrome.storage.sync` and hold no hidden values.

## For organizations

An admin can push rules to every browser through Chrome policy; the schema is [`managed_schema.json`](managed_schema.json): `disabled`, `allow`, `patterns`, and `allowTurningOff: false` to stop people from switching Veil off on a site or turning a kind off. People's own allow entries and patterns still apply on top.

## When a site changes

Each site has specific selectors plus generic fallbacks (a message box inside a form, that form's submit button). Below those, a safety net guards any text area or editable box you type in (not one-line inputs) and any nearby button labelled send or submit, in ten languages. Veil starts before the page's scripts and listens first, so no site handler sees a send before Veil does. If it finds no message box at all for 6 seconds, the toolbar icon shows an orange **!** and the popup explains that what you send there isn't checked.

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

`npm test -w @veil/extension` loads the built extension into Chromium (Playwright) and drives stand-in chat pages served at the real addresses. The pages use the same editors as the sites: ProseMirror (ChatGPT, Claude), Quill (Gemini), and the plain textarea logged-out ChatGPT showed in Oct 2026. Covered:

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

- **Settings and popup:** switched off per site, allowed values and custom patterns, changes applied to open tabs, the popup's status, audit counts (no values in the log) and rule errors.
- **Undo** on ProseMirror and on a textarea, letting exactly one message through.
- **Names and addresses** masked in the message box.
- **Safety net:** a redesigned page with an unknown message box and send button, and the **!** badge when there is no message box.
- **Probing:** the page can't fetch Veil's files.

37 tests in all, plus unit tests of the settings. Also checked by hand on live chatgpt.com (logged out, Oct 2026): Veil stopped the send and masked the box.

## Known limits

- **Names and postal addresses** are found with rules and a list of 6,700 first names, not a model: a name the list doesn't know is found only with context ("Hi Kofi,", "my name is", a sign-off, a title such as "Mr").
- **Width is visible.** The padding tells the page roughly how wide a value is, nothing else about it.
- **Copying from the page gives placeholders.** Selecting text, or a site's own copy button, copies the masked text. Use Copy in the Veil window for real values.
- **Long values** wider than their line are shortened with "…" on screen; the Veil window shows them in full on hover and copies them in full.
- **Fonts.** The overlay can't use a site's own web fonts, so a value may look slightly different from the text around it; it shrinks a little before shortening.
- **Screen readers** hear the placeholders: the overlay is hidden from assistive technology so it isn't read twice.
- **Detectable once it acts.** A page can't fetch Veil's files to probe for it (`use_dynamic_url`). Once Veil shows a value or its window, the page can see a Veil frame and its address.
- **After a browser restart** older conversations show placeholders, since the vault is cleared on purpose.
- **Redesigns.** If a redesign hides the message box from the selectors and the safety net, Veil can't check that page; the orange **!** tells you so.
- **Chrome policy timing.** Without a policy installed, Chromium can leave the policy read unanswered, so Veil waits 300 ms for it at most.
