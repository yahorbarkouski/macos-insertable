# Native architecture

## Purpose

The native addon translates the `NativeBridge` calls in `src/bridge.ts` into macOS operations. It exposes platform facts and small operations. TypeScript owns field classification, delivery strategy, retries between delivery methods, clipboard restoration policy, and public refusal reasons.

The fused draft compare-and-swap is the exception. Focus proof, region comparison, selection, replacement, read-back, and optional caret parking stay in one native worker because a JavaScript round trip between those steps would break the transaction.

## Modules

| Module | Owns |
| --- | --- |
| `addon.mm` | Per-environment state creation, the 26 exported names, and addon registration. |
| `addon_state.h/.mm` | Retained AX element tokens and ARC-owned pasteboard snapshot tokens. |
| `napi_support.h/.mm` | Promise worker plumbing and checked JavaScript-to-native numeric conversion. |
| `accessibility_internal.h/.mm` | AX attribute decoding, text and identity records, timeouts, focused-element lookup, and JS encoding shared by AX operations. |
| `accessibility_read.mm` | Capture, reread, focus verification, caret bounds, confirm, and accessibility priming. |
| `accessibility_edit.mm` | Selected-text, whole-value, selection-range, and parameterized range writes. |
| `accessibility_cas.mm` | The complete draft compare-and-swap transaction and its two measured write tactics. |
| `system.mm` | Trust, Secure Event Input, modifier state, fresh WindowServer foreground PID, and app metadata. |
| `input.mm` | Process-targeted key chords, active-layout lookup, and chunked Unicode typing. |
| `pasteboard.mm` | Snapshot, restore, discard, transient text write, and the 16 MiB retained-data budget. |

Public module headers declare N-API callbacks for `addon.mm`. Callbacks stay beside the worker they queue. A maintainer can trace an exported method through its argument checks, worker, and OS call in one implementation file. The shared helpers contain mechanics only. They do not choose a delivery tactic or classify a target.

## Dependency direction

```text
addon
  -> accessibility | system | input | pasteboard

accessibility read/edit/CAS
  -> accessibility internal -> addon state
  -> N-API support

input
  -> system
  -> N-API support

system
  -> N-API support

pasteboard
  -> addon state
  -> N-API support
```

Domain modules do not call one another except `input` using the fresh foreground-PID fact owned by `system`. The architecture check rejects unlisted Objective-C++ sources, misplaced addon registration, forbidden native include edges, and any mismatch between addon exports and `NativeBridge`.

## Threads

- AX calls message another process and may block. They run in `Napi::AsyncWorker::Execute` with an explicit AX messaging timeout.
- `Execute` uses C++, Core Foundation, AX, and Core Graphics values only. It never creates or reads an N-API value.
- `OnOK` runs on the JavaScript thread and converts the completed native record into the existing `NativeBridge` result shape.
- Node may terminate a worker environment after native work is queued. The addon enables node-addon-api's documented unthrowable-exception guard, so Node can cancel completion or discard a result that can no longer enter JavaScript instead of aborting the process. A child-process contract test bounds and exercises this teardown path repeatedly.
- AppKit and pasteboard calls remain synchronous on the N-API callback thread. The addon does not dispatch to the Cocoa main queue because a plain Node host may not service a main run loop.
- Fresh focus checks use the WindowServer list. Notification-fed `NSWorkspace` and system-wide AX focus caches can freeze in a host without a serviced run loop.

## Lifetimes

Each addon environment owns one shared `AddonState`. Export callbacks receive a pointer to that state, and queued workers copy its `shared_ptr`. Environment cleanup revokes the environment's map ownership while an admitted worker may finish with its own shared state reference.

`ElementRegistry` retains an `AXUIElementRef` when capture creates an `ax-*` token. Each worker copies its own retain and releases it after the operation. `releaseElement` is idempotent and removes the registry retain.

`PasteboardStash` holds copied `NSPasteboardItem` arrays behind single-use `pb-*` tokens. ARC is required for every Objective-C++ source so those arrays stay alive across JavaScript run-loop turns. Restore and discard consume the token.

The registries have no arbitrary entry cap. Adding one would change valid behavior at an unmeasured threshold. Environment cleanup bounds abandoned entries to the environment lifetime; the existing pasteboard snapshot keeps its 16 MiB per-snapshot data budget.

## Invariants

- The addon keeps the exact `NativeBridge` method names, argument order, synchronous or promise behavior, and result fields.
- N-API callbacks validate primitive kinds and numeric meaning before conversion. PIDs are positive integers. Timeouts are finite and non-negative. UTF-16 offsets and lengths are non-negative integers with checked ends. CAS edit bounds fit the expected string. Negative caret values retain their existing sentinel meaning. Any nonzero `preferSplice` value remains true.
- Invalid asynchronous calls reject with `TypeError`. Existing synchronous methods keep their conservative false, count, or undefined result.
- JavaScript string indexes, `CFRange`, and draft strings use UTF-16 units.
- Secure-field text is withheld before it reaches the JavaScript heap.
- AX success does not prove mutation. Writes keep their read-back checks and the measured 10/35/35 ms Chromium mirror-settle schedule.
- `CFEqual` on the retained and focused AX elements remains the native focus identity proof.
- Native placeholder-phantom handling stays aligned with TypeScript so whole-value splice never materializes decoration.
- Synthetic input checks the foreground PID before and after delivery, posts real modifier events, and resolves the current keyboard layout for Command-V.
- Pasteboard payloads never enter JavaScript. Clipboard change-count ownership remains a TypeScript decision.
- Objective-C pasteboard exceptions are contained at the N-API boundary and converted to conservative typed results; they never unwind into Node.

## Deliberate deferrals

Same-token AX operations can currently overlap. Per-token serialization may be correct, but it changes scheduling and needs a deterministic concurrency test before inclusion. A global AX queue is not acceptable because one wedged target would block unrelated applications.

The extraction keeps existing manual Core Foundation ownership. A broad RAII conversion has different failure modes and would make retention changes harder to distinguish from file movement.

Off-main-thread AppKit fallback results are not defined by `NativeBridge`. This refactor documents the current host requirement without inventing inconsistent release-mode fallbacks or deadlock-prone main-queue dispatch.
