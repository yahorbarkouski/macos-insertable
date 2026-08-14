# macos-insertable

Find the focused text field of any macOS application, learn whether text can be inserted there,
and insert it — **verified**, through the Accessibility API, with clipboard and keystroke
fallbacks that borrow rather than take.

Built for dictation tools, AI assistants, snippet expanders — anything that produces text and
needs it to land in whatever the user was just typing in, and *only* there.

```ts
import { insertText } from 'macos-insertable'

const outcome = await insertText('Hello from the outside.')
// { delivered: true, via: 'accessibility' }
// or: { delivered: false, reason: 'secure-input' }
// or: { delivered: false, reason: 'not-insertable', capture: { status: 'secure-field', … } }
```

## Why this exists

Most tools that "type into any app" do one thing: overwrite the clipboard and post ⌘V at
whatever holds focus *at delivery time*. That works until it doesn't — the paste lands in the
wrong window, the user's clipboard is clobbered, a password field eats the transcript, and
nothing ever reports failure.

This library takes the opposite contract:

- **Detection over guessing.** An element is a text field because of what it *advertises*
  (text content + an insertion point), not because its role is on a list. Rich editors routinely
  focus an `AXGroup` container that matches no text role — a role allowlist rejects all of them.
- **Capture now, deliver later.** The focused element is pinned at capture (a live reference
  inside the target app) and re-proven before every write — same process frontmost, same live
  element object, same identity fingerprint. Focus moved on? The insert **refuses with a typed
  reason** instead of writing into the wrong field.
- **Verified writes.** The Accessibility API's dominant failure mode is the silent no-op that
  reports success. Every precise write is read back (with a settle loop for apps that mirror
  their text asynchronously) before it is reported delivered.
- **The clipboard is borrowed, never taken.** Snapshotted natively before, restored after —
  unless the user copied something of their own meanwhile, in which case theirs wins. Written
  text carries [nspasteboard.org](http://nspasteboard.org) concealment markers so clipboard
  managers don't archive it.
- **Passwords are out of scope, structurally.** A secure field's text never reaches the JS heap
  (withheld in native code), it classifies as its own status, and no insertion will ever be
  attempted against one. Delivery also refuses while Secure Event Input is active anywhere.

## Install

```bash
npm install macos-insertable
```

macOS 11+. Building from source needs the Xcode Command Line Tools. On other platforms the
package installs as an inert dependency and reports `{ status: 'unsupported' }` — cross-platform
apps can depend on it unconditionally.

Every read and write requires the **Accessibility permission** (System Settings → Privacy &
Security → Accessibility) for the process using the library. `checkAccess()` reports the state;
`npx macos-insertable doctor` checks it from the terminal.

## API

### `checkAccess(): Access`

`{ supported, trusted, secureInput }` — answered without touching any other process.

### `readFocusedField(options?): Promise<Capture>`

What is focused right now, and is it insertable? Pure data out, nothing to release:

```ts
const capture = await readFocusedField()
switch (capture.status) {
  case 'field':         // capture.field: kind, surface, label, value, selection, readOnly…
  case 'secure-field':  // a password/OTP field — never captured, never written to
  case 'disabled':
  case 'not-a-field':   // something focused, but not a place text goes (role reported)
  case 'no-element':    // app reports nothing focused (common: Chromium apps without an AX tree)
  case 'no-permission':
  case 'unsupported':
}
```

`capture.field.surface` tells you how insertion will work: `readable` (precise, verified
Accessibility writes) or `opaque` (aimed trusted input — canvas/model-backed editors).

### `captureFocusedField(options?): Promise<CaptureResult>`

The dictation pattern: pin the field **now**, deliver **later** — after transcription, a network
round trip, a user pause. The `field` arm is a live handle:

```ts
using captured = await captureFocusedField()   // Symbol.dispose releases the native reference
if (captured.status === 'field') {
  // …seconds pass, the user may click around…
  const fresh = await captured.reread()        // null ⇒ the world moved on; recapture
  const result = await captured.insert(transcript, { mode: 'caret' })
}
```

`insert(text, { mode, strategy })`:

- `mode`: `'caret'` (default) | `'selection'` | `'all'`. `all` is only ever delivered through
  the verified Accessibility write — replacing a document that can't be read back is
  destruction, not an edit, and is refused.
- `strategy`: `'auto'` (default: accessibility → clipboard → keystrokes) | `'clipboard'` |
  `'keystrokes'` for callers with their own knowledge of the target.

Every failure is a typed `InsertRefusal` — `'app-changed'`, `'element-changed'`,
`'secure-input'`, `'read-only'`, `'paste-did-not-land'`, … — because "it did nothing" is the
whole bug report otherwise.

### `insertText(text, options?): Promise<InsertTextOutcome>`

The one-call form: capture the frontmost app's field, insert, release. When nothing insertable
is focused, the capture verdict rides along so you can explain *why*.

## CLI

```bash
npx macos-insertable doctor        # permission and platform state
npx macos-insertable watch 30      # follow the frontmost app; click into fields to test them
npx macos-insertable sweep         # one pass over running apps (their remembered focus)
```

Metadata only — roles, kinds, labels, lengths. Field content never leaves the process.

## How delivery works

```
insert(text)
  │  preflight: permission · secure-input · read-only · mode/selection sanity
  │             app still frontmost · same live element (CFEqual) · same identity
  ▼
  1. Accessibility write        readable surfaces; read back and VERIFIED (settle loop
  │                             for apps that mirror text asynchronously)
  ▼  (write refused or unverified)
  2. Clipboard paste            pasteboard snapshotted natively → text written with
  │                             concealment markers → real ⌘V key events posted to the
  │                             target pid → field read back → snapshot restored only if
  │                             still ours (changeCount) — concurrent borrows serialized
  ▼  (pasteboard un-borrowable)
  3. Synthetic keystrokes       chunked Unicode key events, no clipboard involvement
```

Details that took the scars to learn, so you don't have to:

- ⌘V is posted as **real modifier key events** around the V keystroke, not just event flags —
  Chromium-family apps track modifiers from the event stream and treat a flag-only chord as a
  bare `v`.
- Focus is read from the **window server's window list**, not `NSWorkspace` and not the AX
  system-wide focused application: both of those are notification-fed caches that silently
  freeze at their first answer in a process without a serviced run loop — i.e. every plain
  Node.js process. (Measured; the E2E suite exists because of it.)
- A failed paste **leaves the text on the clipboard** — content the user can still paste by
  hand beats content that vanished.
- Paste verification demands **positive evidence** to report failure: a field that reads empty
  on both sides of a paste proves nothing about the paste.

## Testing

Three tiers, honest about what each proves:

| Tier | Where it runs | What it proves |
| --- | --- | --- |
| `npm test` — 83 unit tests | anywhere (Linux CI included) | every decision: classification, preflight, the ladder, borrowing — against a scripted fake bridge |
| `npm run test:contract` — 8 tests | macOS | the compiled addon: loads, full surface, typed failures, never crashes on bad input, snapshots survive run-loop turns |
| `npm run test:e2e` — 8 tests | macOS + Accessibility grant + idle desktop | the real thing: a live AppKit app is spawned, focused, captured, written into, and read back — all three rungs, secure-field refusal, wrong-app refusal, clipboard restoration |

The E2E suite compiles its own AppKit host (`test/e2e/TestHost.swift`) and briefly takes real
keyboard focus; run it when you're not typing.

## Security model

- Requires the user-granted Accessibility (TCC) permission; nothing works without it.
- Password/OTP fields: text withheld in native code, classified `secure-field`, never a target.
- Secure Event Input active anywhere ⇒ delivery refuses (`'secure-input'`).
- Field text stays in-process, capped, and made well-formed before it can cross a serializer.
- Clipboard writes are marked transient/concealed for clipboard managers and attributed via
  `org.nspasteboard.source`.

## Platform scope

macOS only today. The native surface is one deliberately platform-neutral interface
(`NativeBridge`, ~18 primitives); a Windows UI Automation backend can satisfy it unchanged —
`GetFocusedElement`/runtime-ids/`ValuePattern` map one-to-one onto the read/verify/write calls.
Contributions welcome.

## License

MIT
