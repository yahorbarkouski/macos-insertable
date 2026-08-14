/**
 * Waiting out the user's own modifier keys before posting synthetic input.
 *
 * The hazard is specific to hotkey-driven callers, which is most of them: a hold-to-talk chord
 * is released at the exact moment delivery begins, and a ⌘V posted while ⌘⇧ is still physically
 * down can reach the target as ⌘⇧V — a different command, sometimes destructive. The
 * Accessibility rung is immune (it posts no events); the paste and typing rungs are not.
 *
 * Polling rather than observing: an event tap would need permissions and a serviced run loop
 * this library deliberately does not require.
 */

import type { NativeBridge } from './bridge.js'

/** How often to re-read the hardware modifier state while waiting. */
const POLL_MS = 15

export interface ModifierWaitOptions {
  timeoutMs: number
  /** Injected in tests; defaults to a real timer. */
  wait?: (ms: number) => Promise<void>
}

/**
 * Resolves true once no modifiers are held, or false when the timeout expires with the user
 * still holding them. A zero timeout skips the check entirely and reports success — callers who
 * post from a context where modifiers cannot be down should not pay for a syscall.
 */
export async function waitForModifiersReleased(
  bridge: NativeBridge,
  { timeoutMs, wait = defaultWait }: ModifierWaitOptions
): Promise<boolean> {
  if (timeoutMs <= 0) return true
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (bridge.currentModifierFlags() === 0) return true
    if (Date.now() >= deadline) return false
    await wait(POLL_MS)
  }
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
