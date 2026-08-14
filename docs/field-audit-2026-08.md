# Field audit — August 2026

Five parallel audits ran against this library: the Espanso injection engine (the most-deployed
OSS injector), deep reads of Handy and VoiceInk, a survey of seven more active dictation apps
(Whispering/Epicenter, Vibe, OpenWhispr, Lirevo, Amical, Yap, fnkey), a validation of the
classifier against Chromium and WebKit **source**, and a hunt through the advanced AX text APIs
(with compiled probes run on a live machine, and one AppKit disassembly). This file is the
synthesis: what we were wrong about, what to adopt, what the field gets wrong that this library
solves, and the reference tables.

Nothing here is speculation unless marked; every claim traces to engine source, a shipping
app's code, a filed issue, or a probe run during the audit.

---

## Part 1 — What we were wrong about

Ranked by severity. Status: FIXED / FIX-NEEDED / HARDEN / DOCUMENT / WATCH.

### 1.1 The paste chord is wrong on plain Dvorak/Colemak — FIX-NEEDED

`postPaste` posts hardcoded virtual keycode 9 ("physical V holds on any layout"). True for the
"Dvorak — QWERTY ⌘" layout family; false for plain Dvorak/Colemak, where keycode 9 + Cmd is
**⌘K** — a different, possibly destructive action. Two independent implementations resolve the
keycode per layout (Amical's `KeyboardLayoutResolver`, fnkey's `UCKeyTranslate` scan over
keycodes 0–127). Fix scope: the paste/return chord only — the typing rung uses Unicode payloads
and is layout-immune (see 5.3).

### 1.2 The 0.3.1 editability rule survives both engines — but our explanation was wrong twice

Verdict from engine source: **outcome CONFIRMED, causal story falsified in both directions.**

- The caret vocabulary we measured on Chromium buttons/transcripts is **not stamped by
  Chromium**. It's AppKit's new-API accessibility bridge synthesizing
  `AXInsertionPointLineNumber`/`AXSelectedTextRange` onto every element of any new-API app — a
  plain **Finder button** carries them too (live-probed).
- The editable markers come from Chromium's `AXPlatformNodeCocoa` superclass, exposed on every
  node with `ax::mojom::State::kEditable` (entire editable subtrees, focus-independent). Landed
  ~M120; **absent in ≈M100–M119** — a version floor to remember for old Electron apps.
- In **WebKit the marker clause is vacuous**: `AXEditableAncestor` sits in the base attribute
  list of nearly every object (only WebAreas remove it). There it is the *caret* clause that
  discriminates — WebKit grants `AXSelectedTextRange` only to `isTextControl()` roles.

The two engines are mirror images: Chromium floods caret attrs (via AppKit), markers
discriminate; WebKit floods markers, caret attrs discriminate. The conjunction in
`hasTextCapability` survives both inversions — for opposite reasons. The comments in
`classify.ts` and the README attribute the flood to Chromium and should be rewritten.

**Safari is safe from the feared false negative**: WebKit maps `contenteditable` →
`AccessibilityRole::TextArea` → the role rule (R1) catches Gmail/Notion-in-Safari before the
container rule is ever consulted. Residual edge: an explicit foreign ARIA role (e.g.
`role="application"`) on a contenteditable suppresses both the role and the caret attrs — both
rules miss it. Rare, real, documented here.

### 1.3 "Browser editors expose nothing settable" is outdated — DOCUMENT (comment fix)

Live measurement: current Electron/Chromium editable fields report `AXValue` **and**
`AXSelectedText` as settable (so they classify `readable` — strictly better than our comments
claim). The stale premise lives in `classify.ts`'s `isReadOnly` comment. Behavior is correct;
prose is wrong.

### 1.4 Container settability is not a clean editability oracle — HARDEN

One non-editable Electron `AXGroup` was measured reporting settable value+selection (with
AppKit-synthesized caret attrs) — it would pass the container rule through the settability
disjunct. The markers were correctly absent; settability was the misfiring term. Hardening
option: for **role-less containers**, rank markers above settability (markers are the only
source-guaranteed Chromium editability signal); bare-settability containers could demote to
paste-only. Not yet applied — needs a check that no measured-good surface regresses.

### 1.5 The dormant-Electron `no-element` verdict is honest but incomplete — DOCUMENT + design

Yap's source states the field's consensus: *"Electron and web apps report no focused element at
all, so any such gate silently refuses to paste into Slack, VS Code, Discord and friends."*
Every surveyed app pastes blind in that state; we refuse. Refusal should stay the default — but
the library needs an **explicit, typed blind escape hatch** (opt-in, reported as its own
unverified delivery kind) or real dictation products cannot adopt it for the most common
targets. Related: Amical wakes dormant trees with `AXManualAccessibility` on a browser
allowlist and warns that `AXEnhancedUserInterface` "destabilizes Chromium/Electron on heavy
pages"; OpenWhispr refuses to set **any** AX attribute after `AXEnhancedUserInterface` flipped
Claude Desktop into a state where every later dictation pasted into an unfocused field. If tree
waking is ever revisited (our own measurements showed no benefit), those two scars define the
constraint set.

### 1.6 Our 300ms unverifiable settle is defensible but sits mid-field — WATCH

Shipped restore delays span: Handy legacy 60ms (plus two user-tunable knobs as scar tissue),
Yap/Whispering 100ms, Lirevo 120ms, Espanso 300ms fixed, OpenWhispr 450ms, Amical 700ms,
VoiceInk **2s default (user-tunable)**, Handy's receipt path up to **8s** bounded by read
receipts. Espanso's constant equals ours exactly; VoiceInk's 2s and Handy's 8s exist because
slow Electron/remote-desktop targets read the pasteboard very late. The real fix remains
receipt-sequenced restore (pasteboard promise + `provideDataForType:` as read receipt — see
Handy's `paste_tx`); until then 300ms is a documented compromise, not a solved problem.

### 1.7 The two-step selection write can silently no-op on WebKit — WATCH

Live: `set kAXSelectedTextRange` + `set kAXSelectedText` on a hidden/unfocused Safari
**returned success and edited nothing**. Foreground-focused behavior unverified. Our read-back
verification already converts this into a clean fall-through (the doctrine paying off — both
engines produced success-reporting no-op writes during the audit), and `AXReplaceRangeWithText`
(2.1) is the proper WebKit path.

### 1.8 Typing-rung divergences from Espanso — WATCH

We set the Unicode payload on both key-down and key-up; Espanso deliberately sends a bare up
(their issue #159). No macOS evidence of double-insertion (our E2E shows none), but it's a
named divergence. Their carrier vkey is 0x31/space, ours is 0 ('a') — apps that dispatch on
keycode rather than payload see a different key. Their chunk size is 20 UTF-16 units to our 16
(both empirical; no authoritative Apple limit — CGEvent.h explicitly warns frameworks may
ignore the Unicode string entirely). Qt apps drop all but the first characters of multi-char
chunks (Espanso #1304, Anki) — if `strategy: 'keystrokes'` misbehaves in Qt, per-char chunking
is the fallback.

### 1.9 Flag-only ⌘V ships at scale — position held, claim softened

OpenWhispr and Lirevo ship flag-only chords to real Chromium-heavy user bases; Yap
independently ships real modifier events *plus* the Carbon-era `NX_DEVICELCMDKEYMASK` device
bit "because Qt and Java apps read the device-dependent bits". Our real-modifier-events choice
is the safer superset and stays; the README's "Chromium treats a flag-only chord as a bare v"
should be softened to "some toolkits" pending a controlled matrix test. The device-bit addition
is a one-line candidate worth testing.

---

## Part 2 — What to adopt (ranked by value ÷ risk)

### 2.1 `AXReplaceRangeWithText` as a WebKit/AppKit write rung

One-call range replace, live-proven working on Safari from an external client — **even
unfocused**, where the two-step no-ops. Wire format (runtime-verified; fuzzed against ~150
alternatives, all of which silently no-op):

```objc
NSDictionary *payload = @{ @"AXReplacementRange": AXValue(kAXValueTypeCFRange),
                           @"AXReplacementText" : NSString };
AXUIElementCopyParameterizedAttributeValue(el, CFSTR("AXReplaceRangeWithText"), payload, &out);
```

On AppKit it routes through `insertText:replacementRange:` on the current input context — the
TSM path IMEs and Apple Dictation use: real undo coalescing, delegate events, no selection
disturbance — gated on the element being the app's focused element. On WebKit it's a
first-class editing command (`ReplaceRangeWithTextCommand`). **Chromium: advertised but inert**
(its equivalent is feature-flagged off) — fall through to existing rungs.

Two hazards, both load-bearing: the attribute is *advertised on essentially every element of
every app* (Finder buttons, secure fields), so advertisement means nothing — feature-detect by
attempting + verifying. And a payload with a wrong key **deletes the range while returning
success** (measured). Keep read-back verification; the exact key strings are the API.

### 2.2 Secure-input culprit naming

Three independent implementations (Espanso, Handy, Yap — Yap's is cleanest and corrects the
folklore: `kCGSSessionSecureInputPID` lives on the IORegistry **root**, not IOResources).
Read the pid, name the app via `proc_pidpath`/`NSRunningApplication`. Turns the
`'secure-input'` refusal into "close the password prompt in **Chrome**". ~40 lines. Caveat all
three document: the pid can be wrong/absent when the grab was taken while backgrounded.
Espanso's remediation playbook (blur Chrome windows — Chrome holds the grab for background
password fields; restart password manager; screen lock releases stuck grabs) belongs in the
troubleshooting docs.

### 2.3 `caretBounds()` — caret rectangle in screen coordinates

`AXBoundsForRange` with a zero-length range at the caret returns the literal caret rect
(runtime-verified: `148,1015 0×14`). `AXBoundsForTextMarkerRange` is the web-content
equivalent (both engines implement it; the *reverse* point→marker direction is
advertised-but-inert in Chromium — don't hit-test). Fallback trick from a shipping ghost-text
app: when a Chromium field exposes no caret range, `boundsForRange(n-1, 1).maxX` keeps real
line height. Unlocks caret-anchored HUDs, ghost text, correction popovers. Near-zero risk.

### 2.4 Terminal-target awareness

OpenWhispr refuses selection-replacement in terminals because **replacement text typed into a
shell executes on its embedded newlines** — a safety gate we lack for multiline inserts and
`submit()`. Their terminal-signature list (bundle-id based) is the seed data. Cheap: a
`terminal` hint on the capture (bundle-id signature match) letting callers gate multiline and
submit. Same family: VS Code/JetBrains/Sublime copy the whole line on ⌘C with an empty
selection — any future synthetic-copy selection probe must know that list or it hallucinates
selections.

### 2.5 Layout-resolved chord keycodes

Fix for 1.1: resolve the "v" keycode via `UCKeyTranslate` over the current
`TISCopyCurrentKeyboardLayoutInputSource`, cache per layout-change. Note the scope boundary:
this is for **physical chord synthesis only** — for the typing rung, layout resolution is
pointless (Unicode payload) and both Espanso and the audit conclude it reintroduces fragility.

### 2.6 Stale-TCC ("Broken") detection

Whispering's `DictationCapability::Broken`: after an app update, `AXIsProcessTrusted()` keeps
returning true while event delivery is dead; only a liveness probe exposes it, and the user
remediation differs ("remove and re-add" vs "toggle on"). Espanso's tracker independently
documents the same class (#2562, #1397, #2402: cert rotation → stale grant). `checkAccess()`
should grow a distinct state, likely via a cheap self-probe. Also worth copying: Lirevo checks
trust via `AXIsProcessTrustedWithOptions(NULL)` because plain `AXIsProcessTrusted()` caches
per-process.

### 2.7 Placeholder-leak detection

Quill and ProseMirror-style editors leak the **visible placeholder** as `AXValue`; our
`field.value` reports it as real content (corrupts prompt-building; makes `'all'` mode
semantics wrong). Amical ships three bounded heuristics (placeholder == value; `ql-blank` in
`AXDOMClassList`; ProseMirror placeholder descendant match) — directly portable.

### 2.8 `AXObserver` push events, scoped to the live capture

`kAXFocusedUIElementChanged` / `kAXSelectedTextChanged` / `kAXValueChanged` /
`kAXUIElementDestroyed` on the captured app only, torn down on release — turns
`element-changed`/`draft-drifted`/`element-gone` from poll-and-hope into push signals, and
enables OpenWhispr-style correction learning (they diff user edits against the pasted
transcript via an `AXValueChanged` observer and grow their STT dictionary). Constraint we
already know intimately: callbacks need a **serviced CFRunLoop** — in plain Node that means a
dedicated `CFRunLoopRun` thread in the addon. Scope narrowly; `AXValueChanged` app-wide on a
chatty Electron app floods.

### 2.9 Text-marker tier for Chromium caret placement (future)

Marker CF functions are **public API since macOS 12** (`AXTextMarkerCreate` etc. in
`AXUIElement.h` — the dlsym folklore is obsolete). The `AXSelectedTextMarkerRange` **setter**
dispatches a real `kSetSelection` action in Chromium and works on arbitrary contenteditable
where offset attributes are inert. Pattern: place caret via marker range, then deliver via
paste/keystrokes (Chromium cannot AX-replace). Higher risk: version-pinned reachability, lazy
trees. Amical's selection extractor (marker-primary, 5-path fallback ladder) is the reference
implementation for the read side.

### 2.10 Small wins

- **`AXConfirm` action before synthesizing Return** in `submit()` — keystroke-free submit,
  runtime-verified on `NSTextField` (multiline areas don't expose it; keep the chord fallback).
- **`AXUIElementCopyMultipleAttributeValues`** — batch preflight reads into one IPC round trip.
- **Post-insert convenience**: espanso-style revert-on-Backspace is strictly weaker than our
  draft `update('')`, but a bounded "revert last insert" for the paste/type rungs is a
  recurring product need.
- **Rich-content delivery** (HTML/RTF via `NSAttributedString`, images) on the paste rung —
  Espanso ships it; AI-assistant hosts will ask.
- **Smart joining-space** (OpenWhispr's opener/punctuation tables) as an optional insert
  helper — we have the primitives (value + caret), everyone reimplements the rule.
- **Refusal diagnostics**: include the *current* frontmost pid/name in `paste-not-posted` /
  `app-changed` refusals (OpenWhispr's `COPY_OK <pid> <name>` pattern — wrong-focus incidents
  become self-diagnosing).
- **Per-app profile shape**: VoiceInk's Modes (bundle-id + browser-URL + trigger-word routing
  to per-app settings) is the product layer above our `capture.app` — a documented recipe, not
  library code. Espanso's per-app `backend`/delay overrides are the same shape.

### 2.11 Explicitly not chasing (myths retired by the audit)

- **`AXTextOperation`**: WebKit-native batch replace (with `ReplacePreserveCase`) used by the
  system; Chromium mirrors the wire format behind a default-off flag; external invocation from
  a vanilla client fails to marshal the marker arrays (`kAXErrorIllegalArgument`). A
  system-dictation interface, not a client API.
- **"Apple Dictation drives AX TextOperation"**: unsupported. The AppKit disassembly points to
  the plain input-context path (`insertText:replacementRange:`) instead.
- **`UCKeyTranslate` for the typing rung**: pointless for finished-string injection; chord
  synthesis only (2.5).
- **`AXEnhancedUserInterface`**: two independent production scars (window-manager fights;
  OpenWhispr's Claude Desktop focus corruption). Never.

---

## Part 3 — What the field gets wrong that this library solves

Across ten audited codebases (Espanso, Handy, VoiceInk, Whispering, Vibe, OpenWhispr, Lirevo,
Amical, Yap, fnkey): **none classifies the field before writing, none verifies delivery by
read-back, none revises in place, none reports typed refusals.** Specifics worth remembering:

| Failure mode in the field | Where seen | Our answer |
| --- | --- | --- |
| Paste into password fields, then blind-Enter into them | VoiceInk (Enter fires 500ms after any paste), Espanso, all | `secure-field` verdict; secure text never enters JS; submit re-proves the element |
| Wrong-window delivery after seconds of latency | all (aim = delivery-time focus; Espanso aims by 200ms sleep) | element pinning + CFEqual + identity + typed `app-changed`/`element-changed` |
| Success reported for writes that did nothing | both engines *measured* returning success for no-op writes; VoiceInk's terminal state is "⌘V was posted" | read-back verification with positive-evidence rule |
| Clipboard clobbering | Handy legacy restores unconditionally; Espanso text-only snapshot destroys copied images (#2059); no concealment (#930) | full-fidelity native snapshot, changeCount guard, concealment markers, serialized borrows |
| Concurrent paste sessions interleaving | VoiceInk detached restore tasks | `withPasteboardTurn` serialization |
| License nag pasted into user documents | VoiceInk (`usageRestrictionMessage` prepended to delivery) | the whole insertion-as-contract design |

Also confirmed unique: streaming in-field revision (drafts). VoiceInk's live transcript stays
in its own panel; Yap deliberately previews in-HUD and argues in-field streaming is an
anti-feature *in terminals* — a position our readable-surface-only gate already agrees with,
and the docs should present HUD-preview as the right pattern for unverifiable surfaces.

Design patterns worth admiring elsewhere: Handy's receipt-sequenced paste (`declareTypes:owner:`
promise; `provideDataForType:` = read receipt; quiet-period + ownership-guarded restore) is the
correct solution to restore timing and remains on our roadmap; Yap's double restore guard
(changeCount AND session-UUID pasteboard type) survives races either check alone mishandles;
VoiceInk's content+marker ownership check survives the clipboard-manager-rewrite edge our
changeCount guard loses (manager rewrites identical text → changeCount bumps → we skip restore
→ user's original lost to the manager's copy). Combining changeCount + our own marker presence
is the robust check.

---

## Part 4 — Timing constants across the field

| Purpose | Field values | Ours |
| --- | --- | --- |
| Typing: per-chunk delay / chunk size | Espanso 1ms / 20 units | 1.2ms / 16 units |
| Clipboard write → chord | Espanso 100ms (Brave patch: 400ms); OpenWhispr 15–120ms; Yap 30ms | 0 (pid-addressed) |
| Intra-chord event gap | Espanso 10ms; VoiceInk 10ms; Yap 10ms; Handy 100ms hold | 0 (pid-addressed; watch-item) |
| Paste → restore (fixed-delay apps) | 60ms → 2s (see 1.6) | verified: 90ms×3; unverifiable: 300ms |
| Receipt-based restore bound | Handy: 200ms quiet, 8s max | not yet implemented |
| AX write settle | n/a elsewhere (nobody AX-writes) | 35ms (draft: native single retry) |
| Modifier-release wait before injecting | Espanso: poll 100ms, 3s timeout | none (hold-to-talk hosts want this) |
| Secure-input poll | Espanso 3s/1s; Handy 1s | on-demand |

## Part 5 — Comment/doc corrections owed (small, in code owned elsewhere right now)

1. `classify.ts` marker/caret comments: attribute the caret flood to AppKit's new-API bridge;
   markers to `AXPlatformNodeCocoa` under `State::kEditable` (M120+, focus-independent); note
   WebKit's mirror-image (markers vacuous, caret attrs discriminate; contenteditable arrives
   as `AXTextArea` via R1).
2. `classify.ts` `isReadOnly` comment: drop "browser editors expose nothing settable" (current
   Electron fields are settable); keep the rule (it still protects the apps where it's true).
3. README "Detection over guessing": same reattribution; soften "Chromium treats a flag-only
   chord as a bare v" to "some toolkits" pending the matrix test.
