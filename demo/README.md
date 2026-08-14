# Demo island

A floating, always-on-top panel that live-classifies whatever field you focus — in any app —
and fires the library's capabilities at it. Not part of the published package (the npm bundle
is a `files` whitelist; nothing here ships).

![The island renames itself as the library's verdict changes.]

## Run

```bash
# from the repo root — the demo requires the built library and compiled addon:
pnpm install && pnpm build

cd demo
npm install          # npm, not pnpm: pnpm v10 blocks electron's postinstall by default
npm start
```

If `npm start` complains the Electron binary is missing (some sandboxed setups gate the
postinstall, and electron's own extractor can fail silently), finish it by hand:

```bash
cd node_modules/electron
node install.js
# still no dist/Electron.app? extract the cached zip yourself:
unzip -q ~/Library/Caches/electron/*/electron-v*-darwin-arm64.zip -d dist
printf 'Electron.app/Contents/MacOS/Electron' > path.txt
```

Grant **Accessibility** when asked (System Settings → Privacy & Security → Accessibility). When
launched from an already-granted terminal the grant is usually inherited; the island's header
tells you either way.

## What you're looking at

The island is **non-focusable** — clicking its buttons never moves keyboard focus. That is the
whole trick: the field you're working in stays focused, so every action targets it, not the
island. (It also floats above window layer 0, where the library's frontmost detection never
looks.)

The **title is the live verdict**, re-read ~4×/second: focus TextEdit and it says
*Insertable — verified writes*; focus a Google Docs canvas → *Insertable — paste only*; a
password box → *Password field — refused*, with every button dead; a button or menu →
*Not a field (AXButton)*. The detail line shows kind, length, selection, and the field's label.

## Buttons → capabilities

| Button | Library call |
| --- | --- |
| **Insert** | `insertText` — one-shot verified insert at the caret |
| **Stream ⚡** | `startDraft` + `draft.update(partial)` — words appear while "spoken", then `their → they're` revised **in place**, per-update latency in the log |
| **Scratch that** | `draft.update('')` — a wrong take streams in, then the region empties; nothing else is touched |
| **Insert + Send** | `insert` + `submit()` — dictate-and-send |

Every button is exactly one public API flow — no demo-side text transforms pretending to be
library features. (`insert` also has `mode: 'selection'` and `mode: 'all'`; they are exercised
by the test suite rather than given buttons.)

The log line at the bottom shows the typed result of every action — including refusals, which
are half the point: click Insert while a password field is focused and watch the library say
no, with a reason.

## A good recording, in order

1. Open TextEdit next to the island. Click into it — title flips to *verified writes*.
2. **Stream ⚡**, then **Scratch that** — the headline features.
3. Focus Safari's address bar, a password field, a plain button — watch the title rename
   itself and the buttons die on the password field.
4. Open Messages, click the compose field, **Insert + Send**.
