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
// { delivered: false, reason: 'secure-input' }
// { delivered: false, reason: 'not-insertable', capture: { status: 'secure-field', … } }
```

And the part nothing else open-source does — **streaming text that revises itself**, at a
measured **0.9ms median** per revision:

```ts
using captured = await captureFocusedField()      // pin the field the user is in
if (captured.status !== 'field') return
const started = await captured.startDraft()
if (!started.ok) return

await started.draft.update('their')               // words appear while the user speaks…
await started.draft.update('their going home')
await started.draft.update("they're going home")  // …and the correction revises ONE word,
                                                  // in place, without repainting the rest
```

## The API in one glance

Ordered by how involved you want to be. Every answer is a discriminated union — you `switch` on
it, and the compiler makes sure you handled every case.

```
checkAccess()            am I even allowed to play?
readFocusedField()       what is focused right now?           (look, don't touch)
insertText(text)         put this where the user is typing    (one-shot)
captureFocusedField()    pin the field now, insert later      (the dictation pattern)
  .insert(text, opts)      caret / selection / all · auto / clipboard / keystrokes
  .startDraft()            a region you keep revising          (streaming, corrections)
  .submit(modifier?)       press the send chord, safely
  .reread()                fresh field state, same element proven first
```

## Why this exists

Most tools that "type into any app" do one thing: overwrite the clipboard and post ⌘V at
whatever holds focus *at delivery time*. That works until it doesn't — the paste lands in the
wrong window, the user's clipboard is clobbered, a password field eats the transcript, and
nothing ever reports failure.

This library takes the opposite contract:

- **Detection over guessing.** An element is a text field because of what it *advertises* —
  text content, an insertion point, and **evidence it is actually editable** (a settable
  value/selection, or the `AXEditableAncestor` markers) — not because its role is on a list.
  Rich editors routinely focus an `AXGroup` container that matches no text role, and a role
  allowlist rejects all of them. The editability clause matters in the other direction: modern
  AppKit synthesizes the caret vocabulary onto *everything* — read-only chat transcripts, even
  Finder buttons — so a caret attribute alone is not evidence. (Verified against Chromium and
  WebKit source; the two engines discriminate through opposite halves of that conjunction.)
- **Capture now, deliver later.** The focused element is pinned at capture (a live reference
  inside the target app) and re-proven before every write. Focus moved on? The insert **refuses
  with a typed reason** instead of writing into the wrong field.
- **Verified writes.** The Accessibility API's dominant failure mode is the silent no-op that
  reports success. Every precise write is read back before it is reported delivered.
- **The clipboard is borrowed, never taken.** Snapshotted natively before, restored after —
  unless the user copied something of their own meanwhile, in which case theirs wins.
- **Passwords are out of scope, structurally.** A secure field's text never reaches the JS
  heap, and no insertion will ever be attempted against one.

## Install

```bash
npm install macos-insertable
```

macOS 11+. Building from source needs the Xcode Command Line Tools. On other platforms the
package installs as an inert dependency and reports `{ status: 'unsupported' }` — cross-platform
apps can depend on it unconditionally.

Every read and write requires the **Accessibility permission** (System Settings → Privacy &
Security → Accessibility) for the process using the library.

```bash
npx macos-insertable doctor     # check permission and platform state
npx macos-insertable watch 30   # click around your apps, watch verdicts stream live
```

## `checkAccess()` — the bouncer

Synchronous, touches nothing outside your process. Call it at startup and whenever you want to
explain to the user why nothing is happening.

```ts
const { supported, trusted, secureInput, secureInputHolder } = checkAccess()

if (!supported)  // not macOS, or addon not built — library is inert, your app still runs
if (!trusted)    // user hasn't granted Accessibility → send them to System Settings
if (secureInput) // a password field is open SOMEWHERE on the system — delivery will refuse
                 // secureInputHolder?.name tells you WHERE: "quit the prompt in 1Password"
```

`secureInputHolder` turns an unactionable refusal into an instruction. macOS documents no
reliable way to ask who holds the grab, so it is best effort (null when the OS won't say, and
the pid can be wrong for a grab taken while the holder was in the background) — but when it
answers, it names the app.

The `secureInput` flag is the one people don't expect: while any app has a password field up,
macOS suppresses synthetic input system-wide. Knowing this *before* the user dictates a
paragraph is the difference between "please close the password prompt" and a mystery failure.

## `readFocusedField()` — the question this library exists to answer

*"Is the thing under the user's cursor insertable?"* Pure data out, nothing to release.

```ts
const capture = await readFocusedField()

switch (capture.status) {
  case 'field':         // yes — details in capture.field
  case 'secure-field':  // a password box. You will never get its text. By design.
  case 'not-a-field':   // something IS focused — a button, a list — role/subrole say what
  case 'disabled':      // a text field, but greyed out
  case 'no-element':    // app reports nothing focused (classic: Electron app without an AX tree)
  case 'no-permission': // the Accessibility grant is missing
  case 'unsupported':   // not macOS
}
```

When it *is* a field, the payload tells you everything routing needs. User in Slack's message
box with `hello world` typed and `world` selected:

```ts
{
  status: 'field',
  app:   { pid: 4242, bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' },
  field: {
    kind: 'area',            // 'field' (one line) | 'area' | 'container' (rich editor)
    surface: 'readable',     // ← the important one, see below
    label: 'Message #general',
    purposeHint: '',         // 'search' | 'url' | 'email' when the platform says so
    multiline: true,
    value: 'hello world',
    selectionStart: 6, selectionEnd: 11, selectedText: 'world',
    readOnly: false,
  }
}
```

**`surface` is the one field to internalize.** It's how the element holds its text, and it
decides everything downstream:

- **`readable`** — the app exposes the text and a writable selection. You can read it (build a
  prompt around it, transform it), and inserts are *precise and verified*: written through
  Accessibility, then read back to prove they landed.
- **`opaque`** — the element behaves like an editor but its text lives somewhere you can't see
  (Google Docs' canvas, Monaco's hidden textarea). `value` is deliberately empty — the library
  refuses to present decoy scratch text as if it were the document. Inserts still work, via
  aimed paste or keystrokes, but can't be read back.

`kind: 'container'` exists because detection is by *capability*, not role name: an element that
advertises text content and a caret is an editor no matter what the application calls it.

## `insertText(text, options?)` — the 90% case

Capture the frontmost app's field, insert, release — one call. For "user pressed the hotkey,
put the transcript wherever they are."

```ts
const outcome = await insertText('On my way, 10 minutes.')

if (outcome.delivered) {
  outcome.via  // 'accessibility' | 'clipboard' | 'keystrokes' — which rung landed it
} else if (outcome.reason === 'not-insertable') {
  outcome.capture.status  // 'secure-field'? Say you don't type into password boxes.
                          // 'no-element'? "Click into a text field first."
} else {
  outcome.reason  // a delivery refusal — see the table below
}
```

`via` matters for product decisions: `'accessibility'` means the write was **verified by
read-back**; `'clipboard'` and `'keystrokes'` mean it was aimed correctly but the target cannot
confirm receipt. Show a softer checkmark for those if you care.

## `captureFocusedField()` — the dictation pattern

The problem in one sentence: **the user focuses a field, talks for eight seconds, and by
delivery time focus may be anywhere.** Clipboard-paste tools type into whatever won focus. This
API pins the actual element at hotkey-down:

```ts
// t=0 — hotkey down. Pin the element (a live reference INSIDE the target app):
using captured = await captureFocusedField()   // `using` auto-releases at scope end
if (captured.status !== 'field') return answerInChatInstead(captured)

// t=0…8s — record, transcribe, call your LLM. User may alt-tab, click around, come back.

// t=8s — deliver. The library re-proves the target first: same app frontmost,
// same LIVE element object (not a lookalike), same identity fingerprint.
const result = await captured.insert(transcript, { mode: 'caret' })

if (!result.delivered && result.reason === 'element-changed') {
  // Focus moved to a different field. The text did NOT go into the wrong one.
  // That refusal — not the happy path — is the feature.
}
```

Two more tools on the handle:

```ts
// Re-read the field only after proving it's still the same element.
// null ⇒ the world moved on (app switched, focus left) — recapture, don't guess.
const fresh = await captured.reread()

// No `using`? Release manually — the pin holds a native reference in the target app.
captured.release()
```

### `mode` — where the text goes

Field state: `hello| world` — caret after *hello*, nothing selected.

| mode | does | result here |
| --- | --- | --- |
| `'caret'` (default) | insert at the captured caret | `hello THERE| world` |
| `'selection'` | replace the captured selection | refused — `'no-selection'` (nothing was selected) |
| `'all'` | replace the whole value | `THERE` — but **only** via the verified write |

The guard rails are opinionated on purpose: `'caret'` refuses when a selection exists
(`'selection-in-the-way'` — inserting would silently eat it), and `'all'` refuses on anything
unverifiable (`'unreadable-replace-all'`) — wiping a document you can't read back isn't an
edit, it's destruction.

### `strategy` — how it travels

`'auto'` (default) climbs the ladder below. Force `'clipboard'` or `'keystrokes'` only when you
know the target better than the classifier does.

## `startDraft()` — streaming, corrections, "scratch that"

Every revision flow transcription and AI apps need is the same operation: *own a region of the
field and keep reconciling it to new text*. A `Draft` is that region.

```ts
using captured = await captureFocusedField()
if (captured.status !== 'field') return
const started = await captured.startDraft()
if (!started.ok) return  // e.g. 'opaque-surface' — canvas editors can't range-edit
const draft = started.draft

// Words appear WHILE the user is speaking — each partial is one edit:
await draft.update('their')                    //  "their"
await draft.update('their going home')         //  "their going home"

// The corrected transcript lands — ONE WORD is revised in place, the rest never repaints:
await draft.update("they're going home")       //  "they're going home"

// An LLM cleanup arriving two seconds later? Same call. User said "scratch that"?
await draft.update('')                         //  region empties, stays owned
```

Three properties make this the fast path:

- **Diff-minimal edits, one native trip.** Each `update` computes the smallest changed span
  (surrogate-safe) and hands it to a single fused native transaction — a compare-and-swap on
  the text region: prove focus → compare the region → replace the span → verify → park the
  caret, atomically, without recrossing the JS boundary between steps. Verification reads only
  the region (`AXStringForRange`), so cost is **O(edit), never O(document)**. Benchmarked in
  the E2E suite against a live AppKit app: **p50 0.9ms** per update on a growing field, and a
  flat **~7–8ms** streaming after a 10,000-character document.
- **No wasted checks.** The hot path deliberately drops two guards the one-shot insert keeps:
  the frontmost check (an Accessibility write lands on the element it *references* — unlike
  synthetic events there is no misdirection to prevent, and dictation that pauses because the
  user glanced at another window would be a bug) and the identity re-read (the region content
  precondition is strictly stronger). What remains is the strongest check available: CFEqual
  against the app's live focused element, plus the content compare-and-swap.
- **Verified, like everything else.** Every update first re-proves the world (same app, same
  element) and then checks the region still holds *exactly what the draft last wrote*. If the
  user edited it, `update` refuses with `'draft-drifted'` — their keystrokes outrank your
  transcript.
- **Selection-aware start.** A draft started while text is selected owns that selection, so the
  first update replaces it — dictating over selected text does what typing over it does.

Drafts need a `readable` surface. On `opaque` ones (`'opaque-surface'` refusal), fall back to a
one-shot `insert` of the final text — honestly, since revisions there can't be verified.

## `submit()` — dictate and send

Both major OSS dictation apps grew an "auto-send" feature, so it's a first-class call rather
than everyone's hand-rolled Enter:

```ts
await captured.insert(transcript)
await captured.submit()             // Enter
await captured.submit('command')    // ⌘-Enter — chat apps disagree on the send chord
```

Same guarantees as insertion: the element is re-proven first, so Enter cannot be pressed in a
different application than the one captured (`'app-changed'` refusal instead). For the
unmodified chord the element's own **confirm action** is tried first where it exposes one —
that commits the field through the application's own handler, with no synthetic event for
modifier state or a focus change to distort.

## Knowing where the text is going

```ts
using captured = await captureFocusedField()
if (captured.status !== 'field') return

captured.traits.terminal      // a shell executes on newlines — gate multiline and submit
await captured.caretBounds()  // { x, y, width: 0, height } in screen coordinates, or null
```

`traits.terminal` exists for a safety reason, not a cosmetic one: text delivered into a
terminal is *executed* on its newlines, so a dictated paragraph that wraps becomes a sequence
of shell commands, and a submit chord runs whatever sits on the prompt. The accessibility tree
cannot express "this is a shell" — a terminal's text area looks like any other — so this is
bundle-identifier evidence, kept as a short auditable list.

`caretBounds()` is the anchor for caret-adjacent UI: a dictation HUD, ghost text, a correction
popover. Zero width, real line height, screen coordinates.

## Every refusal, grouped

```
empty-text · no-permission · secure-input · released           you / your process
app-changed · element-changed · element-gone                   the world moved on → "click back into the field"
read-only · element-disabled                                   the field says no
selection-in-the-way · no-selection · unreadable-replace-all   mode doesn't fit reality
modifiers-held                                                 the user is still on their hotkey
paste-not-posted · paste-did-not-land · type-failed            delivery genuinely failed
draft-drifted · range-write-failed · no-caret ·                draft-specific: the user edited the
opaque-surface · submit-not-posted                             region, or the surface can't range-edit
```

Each maps to a distinct user-facing message. That's the design bet of the whole API: `false`
tells you nothing; `{ delivered: false, reason: 'secure-input' }` tells you what to say.

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

- ⌘V is posted as **real modifier key events** around the V keystroke, not just event flags.
  Some toolkits track modifiers from the event stream they receive and read a flag-only chord as
  a bare `v`; posting the real chord is the superset that costs nothing.
- The **V keycode is resolved for the current layout**, not hardcoded. Physical keycode 9 is "V"
  on QWERTY-shaped layouts, but on plain Dvorak or Colemak that same key under Command is a
  different — possibly destructive — command. Layouts in the "— QWERTY ⌘" family, which remap
  while Command is held, keep the physical code.
- **The user's own modifiers are waited out** before anything synthetic is posted. Hotkey-driven
  callers deliver at the instant a chord is released; a ⌘V that goes out while ⌘⇧ is still down
  is a different shortcut. The Accessibility rung skips the wait — it posts no events.
- Focus is read from the **window server's window list**, not `NSWorkspace` and not the AX
  system-wide focused application: both are notification-fed caches that silently freeze at
  their first answer in a process without a serviced run loop — i.e. every plain Node.js
  process. (Measured; the E2E suite exists because of it.)
- A failed paste **leaves the text on the clipboard** — content the user can still paste by
  hand beats content that vanished.
- Paste verification demands **positive evidence** to report failure: a field that reads empty
  on both sides of a paste proves nothing about the paste.

## CLI

```bash
npx macos-insertable doctor        # permission and platform state
npx macos-insertable watch 30      # follow the frontmost app; click into fields to test them
npx macos-insertable sweep         # one pass over running apps (their remembered focus)
```

Metadata only — roles, kinds, labels, lengths. Field content never leaves the process.

## Testing

Three tiers, honest about what each proves:

| Tier | Where it runs | What it proves |
| --- | --- | --- |
| `npm test` — 121 unit tests | anywhere (Linux CI included) | every decision: classification, preflight, the ladder, drafts and their diffs, borrowing — against a scripted fake bridge |
| `npm run test:contract` — 9 tests | macOS | the compiled addon: loads, full surface, typed failures, never crashes on bad input, snapshots survive run-loop turns |
| `npm run test:e2e` — 11 tests | macOS + Accessibility grant + idle desktop | the real thing: a live AppKit app is spawned, focused, captured, written into, and read back — all three rungs, draft streaming with measured latency, drift refusal, secure-field refusal, wrong-app refusal, clipboard restoration, submit |

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

## How this compares

Ten open-source projects that insert text into macOS apps were read in full — Espanso, Handy,
VoiceInk, Whispering, Vibe, OpenWhispr, Lirevo, Amical, Yap, fnkey. **None classifies the target
before writing, verifies that the write landed, revises text in place, or returns a typed
reason when it fails.** What that costs in practice, what they do better than us, and where
their position is defensible: [`docs/comparison.md`](./docs/comparison.md).

## License

MIT
