# Contributing

## Layout

```
native/insertable.mm   the ONLY platform-specific code: ~18 primitives, no policy
src/bridge.ts          the seam — a platform-neutral interface the addon satisfies
src/classify.ts        pure: what IS the focused element?
src/capture.ts         pin the element, hold it, re-prove it
src/insert.ts          the delivery ladder and its typed refusals
src/cli.ts             doctor / watch / sweep diagnostics
test/                  unit (fake bridge) · contract (real addon) · e2e (real AppKit host)
```

The architectural rule everything else follows: **primitives in native, judgment in
TypeScript.** The addon reads attributes, performs single requested writes, posts events, and
snapshots the pasteboard. Which rung to take, whether a write landed, whether a field may be
written at all — that lives in `src/`, where it runs identically under test on any OS. If a
change adds decision-making to `insertable.mm`, it is on the wrong side of the seam.

## Setup

```bash
pnpm install         # compiles the addon on macOS (Xcode CLT required)
pnpm typecheck
pnpm test            # unit — runs anywhere
pnpm test:contract   # macOS
pnpm test:e2e        # macOS + Accessibility grant on your terminal + an idle desktop
```

The E2E suite compiles `test/e2e/TestHost.swift` into a throwaway app bundle and takes real
keyboard focus while it runs. It cannot run on hosted CI (no way to grant TCC); it is the
release gate you run locally.

## Rules that are not up for debate

- A refusal is a typed reason in the result, never a log line and a bare `false`.
- Nothing from another application's field may be logged or printed — lengths and roles only.
- A password field's text must never reach the JS heap. The native layer withholds it; keep it
  that way.
- `insertable.mm` compiles with ARC and refuses otherwise. Snapshots outlive the call that made
  them; without ARC that is a use-after-free no smoke test can catch.
- Every write path must be verified by read-back or explicitly documented as unverifiable, and
  an unverifiable `all`-mode write is refused, not attempted.
- Focus and frontmost state must come from the window server (`FocusedAppPid`), never from
  `NSWorkspace.frontmostApplication` or the AX system-wide focused application — both freeze
  silently in processes without a serviced run loop.

## Deferred by design

Things that look like obvious additions and are not, so nobody re-derives the reasoning:

- **Receipt-sequenced clipboard restore.** Publishing the text as a pasteboard promise
  (`declareTypes:owner:`) and restoring only once `provideDataForType:` proves the target read it
  is a better answer than any fixed delay. It needs a serviced main run loop — which this library
  deliberately does not require — and an unserviced promise means the target pastes *nothing*.
  Revisit together with the item below; they share the infrastructure.
- **`AXObserver` push notifications** for focus/value/selection changes. Same blocker: callbacks
  need a serviced CFRunLoop, so doing it properly means a dedicated `CFRunLoopRun` thread in the
  addon and a change to the threading contract. Polling (`reread`, and the draft's own
  precondition read) covers current needs.
- **Text-marker caret placement for Chromium.** The `AXSelectedTextMarkerRange` setter is the only
  path that places a caret in Chromium contenteditables, but its reachability is version-pinned
  and needs per-app validation. Drafts already work there via the value-splice tactic, which
  removed the urgency.
- **Blind delivery into applications with no accessibility tree.** Slack, Discord and VS Code
  often report no focused element; every comparable tool pastes anyway, this library refuses.
  A typed opt-in escape hatch is the right shape, but it is a product decision about what a
  library should let callers do unverified — it deserves its own release and explicit docs.
  Refusal stays the default in every design considered.
- **Smart joining-space, rich-content paste, revert-last-insert, per-app profiles.** Useful, none
  load-bearing for correctness. Spacing in particular is *policy* that differs per product; the
  library exposes the primitives (value + caret offset) and the recipe belongs in docs.

## Releasing

Releases publish from CI, so the tarball on npm always corresponds to a commit anyone can check
out, and npm records build provenance against the workflow run.

1. Run the gate locally, including the end-to-end suite that CI cannot run:
   `pnpm typecheck && pnpm lint && pnpm test && pnpm test:contract && pnpm test:e2e`
2. Bump the version and add its `CHANGELOG.md` entry. The publish guard refuses to publish when
   the two disagree.
3. Tag and push: `git tag v0.5.0 && git push --tags`.

The workflow builds both architectures, re-runs the checks, and publishes. One-time setup: an
npm automation token in the `NPM_TOKEN` repository secret.

To publish by hand instead, `npm run prebuild && npm publish`. `prepublishOnly` builds and runs
`scripts/prepublish-check.cjs`, which refuses to publish without build output, without a prebuild
for each architecture, or when the changelog and the version disagree.

Prebuilt binaries are not committed. They are built per release, and N-API keeps each one
ABI-stable across every Node and Electron version, so one per architecture is enough.
