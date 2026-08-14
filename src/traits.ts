/**
 * What the target application is, beyond what its focused element advertises.
 *
 * Exactly one trait so far, and it exists for a safety reason rather than a cosmetic one:
 * text delivered into a terminal is executed on its newlines. A dictated paragraph that wraps
 * becomes a sequence of shell commands, and a submit chord runs whatever sits on the prompt.
 * The Accessibility tree cannot express "this is a shell" — a terminal's text area looks like
 * any other — so this is bundle-identifier evidence, deliberately kept as a short, auditable
 * list rather than a heuristic.
 */

import type { AppIdentity, TargetTraits } from './types.js'

/** Terminal emulators in common use on macOS, by bundle identifier (lowercased). */
const TERMINAL_BUNDLE_IDS = new Set([
  'com.apple.terminal',
  'com.googlecode.iterm2',
  'dev.warp.warp-stable',
  'dev.warp.warp-preview',
  'net.kovidgoyal.kitty',
  'io.alacritty',
  'com.github.wez.wezterm',
  'co.zeit.hyper',
  'com.tabby.app',
  'org.tabby',
  'com.mitchellh.ghostty',
  'com.termius.mac',
  'com.raycast.macos.terminal'
])

/**
 * Bundle-id fragments for terminals that ship under many identifiers (self-built, forks,
 * per-channel bundles). Substring matching is a deliberate second net: a false positive costs
 * a caller an unnecessary gate, a false negative can run a command.
 */
const TERMINAL_ID_FRAGMENTS = ['iterm', 'alacritty', 'wezterm', 'ghostty', 'kitty', 'termina']

export function traitsFor(app: AppIdentity | null): TargetTraits {
  const bundleId = (app?.bundleId ?? '').toLowerCase()
  if (!bundleId) return { terminal: false }
  if (TERMINAL_BUNDLE_IDS.has(bundleId)) return { terminal: true }
  return { terminal: TERMINAL_ID_FRAGMENTS.some((fragment) => bundleId.includes(fragment)) }
}
