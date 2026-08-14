# How this compares

Ten open-source projects insert text into other macOS applications: **Espanso**, **Handy**,
**VoiceInk**, **Whispering/Epicenter**, **Vibe**, **OpenWhispr**, **Lirevo**, **Amical**,
**Yap**, and **fnkey**. Their insertion paths were read in source — not from their docs — and
this is what they do, what breaks as a result, and where this library is and is not better.

It is not a marketing page: Part 4 lists what they do that we don't, and where a competitor's
position is defensible.

---

## Part 1 — The one-paragraph version

Every one of those ten projects performs insertion as **fire-and-forget**: overwrite the
clipboard, post ⌘V (or type characters) at whatever holds focus *at the moment of delivery*, and
report success because the call didn't error. None of them asks what the focused element is
before writing. None reads the field back to confirm the text arrived. None can revise text it
already inserted. None returns a typed reason when it fails. That is not an accusation of
sloppiness — Espanso alone has years of production hardening and a per-app quirk table we
learned from — it is a description of an architecture that was never asked to prove anything.

This library treats insertion as a **contract**: classify the target, pin it, write, verify the
write landed, and return a typed reason when any step refuses. The cost is complexity. The
benefit is that the failure modes filling their issue trackers are structurally impossible here.

---

## Part 2 — What goes wrong in practice

Each row is a real failure mode with its source, and the mechanism that prevents it here.

### 2.1 Text lands in the wrong window

**Them.** Delivery aims at *delivery-time* focus, seconds after the user spoke. Espanso inserts
a hardcoded 200ms sleep "to let the target application regain focus"; Handy and VoiceInk paste
after a full transcription round trip; OpenWhispr re-activates the target app and polls
frontmost 6×25ms hoping it wins. Aiming is by timer.

**Consequence.** Alt-tab during the window and the transcript lands in the other app — logged as
success. This is invisible in a tracker because the user blames themselves.

**Here.** The element is pinned at capture (a retained `AXUIElementRef`), and every write
re-proves it: same app frontmost, same live element by `CFEqual`, same identity fingerprint. A
mismatch returns `element-changed` / `app-changed`. Nothing is aimed by time.

### 2.2 The write silently does nothing

**Them.** Success means "the API call returned" or "the keystroke was posted". VoiceInk's
terminal state is literally `commandPosted`.

**Consequence.** Both engines were *measured during the audit* returning success for writes that
changed nothing — Safari's two-step selection write no-ops on an unfocused window while
reporting success, and `AXReplaceRangeWithText` with a wrong parameter key **deletes the target
range and returns true**. Two shipping tools have that exact bug in their source right now.

**Here.** Every write is verified by reading the element back, with a settle loop for apps that
mirror text asynchronously, and a positive-evidence rule so an unreadable field can't be
convicted. An unverified write falls to the next rung instead of being reported as delivered.

### 2.3 Transcripts pasted into password fields

**Them.** No classification at all, so a secure field is just another paste target. VoiceInk
then fires Enter 500ms later, blind — submitting whatever it just typed into the password box.

**Here.** `AXSecureTextField` is refused in native code *before the value crosses into
JavaScript*, classified as its own `secure-field` status, and no delivery path will target one.
Secure Event Input anywhere on the system refuses delivery outright — with, since 0.4.0, the
name of the app holding the grab.

### 2.4 The user's clipboard is destroyed

**Them.** Espanso's snapshot is **text-only**, so any expansion silently destroys a copied image
or file (open issues #2059, #1226). Handy's default path restores unconditionally after 60ms,
overwriting anything the user copied in that window. VoiceInk's restores are detached tasks that
interleave under rapid dictation. Nobody marks the clipboard transient, so managers archive
every transcript (Espanso #930).

**Here.** Full-fidelity native snapshot (every item × every flavor, 16MB cap, refuses partial
captures), restore guarded by `changeCount` so a newer user copy always wins, borrows serialized
so concurrent inserts can't snapshot each other's text, and nspasteboard concealment markers so
clipboard managers skip the transcript. On failure the text is deliberately *left* on the
clipboard — recoverable by hand beats vanished.

### 2.5 The paste is a different shortcut

**Them.** OpenWhispr and Lirevo post ⌘V as flag-only events (no real modifier keystrokes). Every
project except Amical and fnkey hardcodes physical keycode 9 as "V".

**Consequence.** On plain Dvorak or Colemak, keycode 9 under Command is a *different command* —
this library had the same bug until 0.4.0, found by the audit. And hotkey-driven tools deliver
the instant a chord is released, so a paste can go out while ⌘⇧ is still physically down.

**Here.** Real modifier key events around the keystroke; the keycode resolved through the active
layout (with the "— QWERTY ⌘" family correctly keeping the physical code); and the user's own
modifiers waited out before anything synthetic is posted, refusing with `modifiers-held` rather
than firing a mystery shortcut.

### 2.6 "It did nothing" is the entire bug report

**Them.** The return type is a boolean, an enum of two, or nothing.

**Here.** Eighteen typed refusals, each mapping to a distinct user-facing message —
`secure-input`, `element-changed`, `read-only`, `selection-in-the-way`, `paste-did-not-land`,
`draft-drifted`, `modifiers-held`… A caller can always tell the user what to do next.

---

## Part 3 — What only this library does

**Streaming revision.** `startDraft()` owns a region of the field and reconciles it to new text
via diff-minimal range edits: partials appear as the user speaks, then a correction revises one
word *in place*, `update('')` scratches the take. Measured p50 **0.9ms** per update, flat ~6–8ms
after a 10,000-character document, because verification reads only the edited region
(`AXStringForRange`), never the document. **No audited project has any in-field revision** —
VoiceInk and Yap show live transcripts in their own HUD; everyone else waits for the final text.

**Compare-and-swap semantics.** Each draft update is one fused native transaction: prove focus,
compare the region against what we last wrote, replace the changed span, verify, park the caret.
If the user edited inside the region, it refuses with `draft-drifted` — their keystrokes outrank
the transcript. Nothing else in the field has a concept of "the user got there first".

**Classification as a public answer.** `readFocusedField()` tells you *what* is focused and
whether it's insertable and how (`readable` = verified writes, `opaque` = paste-only), including
the cases that exist to be refused. Amical has the field's richest AX stack and uses it only to
build LLM context — never to gate delivery.

**Testability.** All judgment is pure TypeScript above one platform interface, so 169 unit and
contract tests run on Linux CI with no Mac involved, plus 12 end-to-end tests that spawn a real
AppKit app and drive every rung against it. The audited projects test their transcription; their
insertion paths are verified by users noticing.

---

## Part 4 — Where they're ahead, and where they have a point

**Genuinely ahead of us.**

- **Handy's receipt-sequenced restore** is a better answer to clipboard timing than anyone's,
  ours included: publish the text as a pasteboard promise and restore only once the OS confirms
  the target *read* it. We use a 300ms fixed settle on unverifiable surfaces. Deferred for a
  concrete reason (it needs a serviced run loop), not dismissed — see Part 6 of the audit.
- **Ecosystem knowledge.** Espanso's per-app quirk table — which terminals need which paste
  chord, which apps drop typed characters, which need extra clipboard-observation delay — is
  years of user reports we can only borrow.
- **Product surface.** VoiceInk's per-app/per-URL profiles, Handy's six delivery methods and
  user-tunable delays, both projects' hotkey ergonomics. Every one of those knobs is a scar from
  a real failure. We're a library; they're finished products.

**Where their position is defensible.**

- **Yap argues in-field streaming is an anti-feature** in terminals and agent CLIs — you can't
  cancel a bad take that's already typing. Correct, and our drafts are readable-surface-only so
  terminals are excluded by construction; their HUD-preview pattern is the right one there.
- **Everyone pastes blind into dormant-AX Electron apps.** Slack, Discord and VS Code frequently
  report no focused element; we refuse, they deliver. Refusing is *technically* right and
  *practically* wrong for the most common dictation targets, and we owe callers a typed opt-in
  escape hatch (deferred deliberately, Part 6).
- **Fire-and-forget is not indefensible at their scale.** Espanso serves an enormous userbase
  without verification. Verification is worth its complexity when text is precious and the target
  is unpredictable — dictation, AI assistants — and it earns less in a text expander where the
  user sees the result immediately and retypes the trigger.

---

## Summary

| | The field (10 projects) | This library |
| --- | --- | --- |
| Knows what it's writing into | no | classified, with typed verdicts |
| Aims at | delivery-time focus | element pinned at capture, re-proven per write |
| Confirms delivery | no | read-back verified, positive-evidence rule |
| Reports failure as | boolean / nothing | 18 typed refusals |
| Can revise inserted text | no | drafts, 0.9ms per revision |
| Password fields | pasteable (one auto-submits) | refused before the value reaches JS |
| Clipboard | text-only or unconditional restore | full-fidelity, ownership-guarded, concealed, serialized |
| Paste chord | flag-only or hardcoded keycode | real modifiers, layout-resolved, gated on the user's own keys |
| Insertion tested by | users noticing | 169 unit/contract + 12 live-app E2E |
