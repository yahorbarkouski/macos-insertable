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

## Releasing

1. `pnpm typecheck && pnpm lint && pnpm test && pnpm test:contract && pnpm test:e2e`
2. Bump the version, update `CHANGELOG.md`.
3. `prebuildify --napi --strip` on an arm64 Mac (and x64, or cross-compile) so consumers
   install without a compiler; the loader (`node-gyp-build`) prefers `prebuilds/`.
4. `npm publish`.
