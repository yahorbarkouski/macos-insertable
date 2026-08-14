# Changelog

## 0.3.3

- Drafts now work in Chromium/Electron fields. Two engine facts, both measured against a live
  Chromium textarea: selection-range writes land ~10ms AFTER the same-trip read-back (every
  placement looked failed), and `kAXSelectedTextAttribute` writes are a silent no-op (reported
  success, text unchanged). The CAS trip now verifies placement and text on a mirror-settle
  schedule, and carries a second swap tactic — splice the region into the whole value and
  write that — with the winning tactic reported (`via`) and remembered per draft, so discovery
  is paid once. Chromium streams at ~13–26ms per update; AppKit keeps its ~1ms selected-text
  path (E2E re-proven, p50 1.1ms).
- Demo: a failed stream no longer produces a false-green "scratched" line; added
  `probe-draft.mjs` + `textarea-host.mjs`, a self-contained Chromium draft testbed (probing
  one's own process crashes Chromium — the host is a separate instance).

## 0.3.2

- Decoy geometry: `readFocusedElement` now reports the element's frame and display
  intersection, and an editor whose box is tiny in BOTH dimensions or parked off every display
  classifies as `opaque`. Fixes Google Docs (measured live): its IME decoy carries a value and
  a settable selection, so it classified `readable` and paste verification convicted pastes
  that had visibly landed. Geometry-only — no site lists; a single degenerate dimension is
  deliberately not enough.

## 0.3.1

- Classifier fix: a role-less container now needs **editability evidence** — a settable
  value/selection or Chromium's `AXEditableAncestor`/`AXHighestEditableAncestor` markers — on
  top of the text-and-caret vocabulary. Measured against a live Electron app: Chromium gives
  the caret attributes to read-only transcripts and even buttons (selection exists for
  reading), so a selectable chat transcript classified as a paste-only editor — an insertable
  verdict for a surface no keystroke can change. Browser-hosted editors keep working through
  the marker clause; AppKit editors through settability.

## 0.3.0

- Draft updates fused into one native transaction (`casRangeEdit`): compare-and-swap on the
  text region — prove focus (CFEqual), compare the region, replace the TS-computed span,
  verify over the region only via `AXStringForRange` (O(edit), never O(document)), park the
  caret — atomically in a single worker trip instead of six dispatches and ~20 AX round trips.
  Benchmarked in E2E: **p50 0.9ms** per update, flat ~7–8ms after a 10k-character document.
- The draft hot path drops the frontmost check (AX writes land on the referenced element —
  no misdirection exists for it to prevent; streaming now correctly continues when the app is
  briefly backgrounded) and the per-update identity re-read (the content precondition is
  strictly stronger). `DraftUpdateResult` loses `app-changed`/`element-disabled` accordingly.
- Caret parking became polite: a caret the user moved mid-stream is no longer yanked back;
  parking resumes only if they return it to where the draft left it.

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
