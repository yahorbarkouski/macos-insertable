# Native architecture grounding

## Completion predicate

The refactor is complete when all of these statements are true:

- `native/insertable.mm` no longer exists as a mixed-responsibility compilation unit.
- Addon registration, N-API boundary parsing, AX element access, AX read operations, AX edit operations, synthetic input, system probes, and pasteboard ownership each have one named owner.
- The 26-member `NativeBridge` contract keeps the same names, argument order, sync or promise behavior, and result shapes.
- Product policy remains in TypeScript. Native code exposes OS facts and operations, except for the already fused compare-and-swap transaction.
- Malformed direct native calls cannot send invalid ranges into Core Foundation or throwing C++ string operations.
- A clean native build, typecheck, lint, 230 unit tests, and the addon contract suite pass. The live suite must perform at least as well as its pre-refactor baseline of 14 passes and 3 focus-related failures.
- The native folder contains a short architecture guide that names ownership, dependency direction, thread use, lifetimes, and invariants.

## Current shape

`native/insertable.mm` is 2,020 lines and one anonymous namespace. It contains:

- Core Foundation string conversion and AX attribute readers.
- `ElementRegistry`, a process-global mutex-protected token map that owns retained `AXUIElementRef` values.
- `PasteboardStash`, a process-global mutex-protected single-use token map whose Objective-C values rely on ARC.
- Focused process discovery through the WindowServer and focused AX element lookup.
- Eleven `Napi::AsyncWorker` subclasses.
- Capture, verification, text reads, simple writes, range replacement, caret geometry, confirm, Chromium priming, and the fused draft compare-and-swap.
- Accessibility trust, Secure Event Input, culprit lookup, and frontmost application metadata.
- Process-targeted synthetic key events, keyboard-layout resolution, and chunked Unicode typing.
- Synchronous pasteboard snapshot, restore, discard, and write operations.
- Argument checking, callback adapters, and addon export registration.

## Load-bearing constraints

- AX calls block while messaging another process, so they run on libuv workers with explicit AX messaging timeouts.
- N-API values are created only on the JavaScript thread in worker `OnOK` methods.
- AppKit and pasteboard calls are currently synchronous and assume the N-API callback runs on the Cocoa main thread.
- A plain Node host may not service an `NSRunLoop`. Safety checks must keep using a fresh WindowServer query instead of notification-fed frontmost application caches.
- AX success does not prove a write landed. Read-back and the 10/35/35 ms mirror-settle schedule protect Chromium-backed views.
- JavaScript, `CFRange`, and native draft strings all use UTF-16 offsets.
- Secure-field text is withheld before it reaches the JavaScript heap.
- Placeholder phantom handling in native value-splice must stay aligned with TypeScript classification.
- `CFEqual` on AX elements is the strongest focus identity check in use.
- Process-targeted key events need real modifier events and active keyboard-layout resolution.
- Pasteboard snapshots never enter JavaScript, have a 16 MiB retained-data budget, depend on ARC, and are single-use.
- Clipboard restore remains conditional in TypeScript on pasteboard change-count ownership.
- Packaging stays cross-platform. Missing native binaries resolve to the public `unsupported` state.

## Known risks

- Numeric boundary validation checks JavaScript kinds only. Negative, fractional, non-finite, out-of-range, and inconsistent ranges reach native algorithms.
- Element and pasteboard token registries have no environment cleanup hook or capacity limit.
- Concurrent workers may operate on the same element token. The registry protects ownership, not operation ordering.
- Cocoa main-thread affinity is documented but not enforced.
- Native expected-failure results use several established shapes. Flattening them now would break the public bridge.
- The live E2E suite had three focus-related failures before editing. Structural work must not claim those as new regressions without comparison.

## Design rubric

Candidate designs will be scored on:

1. A maintainer can locate any native behavior from its domain name without tracing more than three files.
2. Dependencies point from addon registration and domain adapters toward small shared AX and N-API support, with no domain-to-domain cycles.
3. The existing `NativeBridge` contract and all load-bearing runtime invariants remain explicit.
4. The design fixes semantic validation at the N-API boundary without moving product policy into native code.
5. The module count and shared abstractions are the minimum that separate independent reasons to change.
6. The migration can be verified after each extraction and ends with deletion of the old file, not a compatibility wrapper.
