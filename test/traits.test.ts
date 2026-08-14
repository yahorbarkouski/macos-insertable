import { describe, expect, it, vi } from 'vitest'

import { waitForModifiersReleased } from '../src/modifiers.js'
import { traitsFor } from '../src/traits.js'
import { fakeBridge } from './fake-bridge.js'

describe('traitsFor', () => {
  it.each([
    'com.apple.Terminal',
    'com.googlecode.iterm2',
    'dev.warp.Warp-Stable',
    'net.kovidgoyal.kitty',
    'com.mitchellh.ghostty'
  ])('recognises %s as a terminal', (bundleId) => {
    expect(traitsFor({ pid: 1, bundleId, name: 'x' }).terminal).toBe(true)
  })

  it('matches forks and self-built bundles by fragment', () => {
    // Terminals ship under many identifiers; a false positive costs a caller a gate, a false
    // negative can run a command.
    expect(traitsFor({ pid: 1, bundleId: 'org.myfork.iTerm2-nightly', name: 'x' }).terminal).toBe(
      true
    )
  })

  it.each([
    'com.apple.TextEdit',
    'com.tinyspeck.slackmacgap',
    'com.microsoft.VSCode',
    'com.apple.Safari'
  ])('does not call %s a terminal', (bundleId) => {
    expect(traitsFor({ pid: 1, bundleId, name: 'x' }).terminal).toBe(false)
  })

  it('answers false for an unknown or missing application', () => {
    expect(traitsFor(null).terminal).toBe(false)
    expect(traitsFor({ pid: 1, bundleId: '', name: '' }).terminal).toBe(false)
  })
})

describe('waitForModifiersReleased', () => {
  it('proceeds immediately when nothing is held', async () => {
    const bridge = fakeBridge()
    expect(await waitForModifiersReleased(bridge, { timeoutMs: 300 })).toBe(true)
    expect(bridge.currentModifierFlags).toHaveBeenCalledTimes(1)
  })

  it('waits for a held chord to clear, then proceeds', async () => {
    // The hold-to-talk shape: the user is still on the hotkey when delivery begins.
    const flags = vi
      .fn<() => number>()
      .mockReturnValueOnce(0x100000)
      .mockReturnValueOnce(0x100000)
      .mockReturnValue(0)
    const bridge = fakeBridge({ currentModifierFlags: flags })
    expect(await waitForModifiersReleased(bridge, { timeoutMs: 300, wait: async () => {} })).toBe(
      true
    )
    expect(flags.mock.calls.length).toBeGreaterThan(2)
  })

  it('gives up rather than posting a chord under held modifiers', async () => {
    const bridge = fakeBridge({ currentModifierFlags: vi.fn(() => 0x100000) })
    expect(await waitForModifiersReleased(bridge, { timeoutMs: 1, wait: async () => {} })).toBe(
      false
    )
  })

  it('skips the check entirely at zero timeout', async () => {
    const bridge = fakeBridge({ currentModifierFlags: vi.fn(() => 0x100000) })
    expect(await waitForModifiersReleased(bridge, { timeoutMs: 0 })).toBe(true)
    expect(bridge.currentModifierFlags).not.toHaveBeenCalled()
  })
})
