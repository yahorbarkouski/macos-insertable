# Changelog

## 0.2.0

- `CapturedField.startDraft()` → `Draft`: a revisable region reconciled to new text with
  diff-minimal, surrogate-safe range edits — one concept covering streaming partials,
  corrections, LLM cleanups, "scratch that" (`update('')`), and dictating over a selection.
  Measured 2–7ms per update against a live AppKit app. Updates re-prove the target and refuse
  with `draft-drifted` when the user edited the region.
- `CapturedField.submit(modifier?)`: posts the send chord (Enter / Shift-Enter / Cmd-Enter)
  after re-proving the captured element, for dictate-and-send flows.
- New native primitives: `setSelectedTextRange` (aim a precise range edit, placement read back
  in the same trip) and `postReturn` (real modifier key events, unknown modifiers refused).

## 0.1.0

Initial release.

- Capability-based detection of the focused text field of any macOS application: an element is
  an editor because of what it advertises (text content + insertion point), not because its
  role is on a list. Verdicts are a discriminated union (`field` / `secure-field` / `disabled`
  / `not-a-field` / `no-element` / `no-permission` / `unsupported`).
- Capture-now-deliver-later: a pinned live element reference, re-proven (frontmost, same
  object, same identity) before every write; `Symbol.dispose` support.
- Verified delivery ladder: read-back-verified Accessibility writes with an async-mirror settle
  loop → borrowed clipboard paste (native snapshot/restore, concealment markers, change-count
  arbitration, serialized borrows, real ⌘-key events) → chunked synthetic keystrokes. Every
  refusal is a typed reason.
- Frontmost/focus state read fresh from the window server — `NSWorkspace` and the AX
  system-wide focused app both freeze permanently in run-loop-less processes (plain Node).
- Diagnostics CLI: `doctor`, `watch`, `sweep`.
- Tests: 83 unit (fake bridge, any OS) · 8 contract (compiled addon) · 8 end-to-end (live
  AppKit host app, all three rungs, refusal paths, clipboard restoration).
