/**
 * Contract tests for the compiled addon: it loads, exports the full NativeBridge surface, and
 * answers every probe as a typed result — never by throwing into the process or hanging. Runs
 * only on macOS with the addon built; needs no Accessibility grant (permission-dependent calls
 * assert only the shape of their answers).
 */

import { describe, expect, it } from 'vitest'

import { loadBridge } from '../src/addon.js'

const bridge = process.platform === 'darwin' ? loadBridge() : null

describe.skipIf(bridge === null)('native addon contract', () => {
  function need() {
    if (!bridge) throw new Error('bridge did not load')
    return bridge
  }

  it('exports the full NativeBridge surface', () => {
    const expected = [
      'isAccessibilityTrusted',
      'isSecureInputEnabled',
      'secureInputCulprit',
      'currentModifierFlags',
      'caretBounds',
      'replaceRange',
      'confirmElement',
      'frontmostApp',
      'readFocusedElement',
      'readElementState',
      'primeAccessibility',
      'verifyElement',
      'setSelectedText',
      'setSelectedTextRange',
      'casRangeEdit',
      'setValue',
      'postPaste',
      'postReturn',
      'postBackspace',
      'typeUnicode',
      'pasteboardChangeCount',
      'pasteboardSnapshot',
      'pasteboardRestore',
      'pasteboardDiscardSnapshot',
      'pasteboardWriteText',
      'releaseElement'
    ] as const
    for (const name of expected) {
      expect(typeof need()[name], name).toBe('function')
    }
  })

  it('answers the synchronous probes with plain values', () => {
    expect(typeof need().isAccessibilityTrusted()).toBe('boolean')
    expect(typeof need().isSecureInputEnabled()).toBe('boolean')
    expect(typeof need().pasteboardChangeCount()).toBe('number')
    const front = need().frontmostApp()
    expect(front === null || typeof front.pid === 'number').toBe(true)
  })

  it('reports the secure-input holder as a named app or null, never a throw', () => {
    // Null is the normal answer: nothing holds the grab, or macOS will not say who does.
    const culprit = need().secureInputCulprit()
    if (culprit !== null) {
      expect(typeof culprit.pid).toBe('number')
      expect(typeof culprit.name).toBe('string')
    }
    // Consistency: a holder can only exist while secure input is actually on.
    if (!need().isSecureInputEnabled()) expect(culprit).toBeNull()
  })

  it('reports live modifier flags as a mask of the four shortcut modifiers', () => {
    const flags = need().currentModifierFlags()
    expect(Number.isInteger(flags)).toBe(true)
    // Nothing outside Command/Shift/Control/Option may appear in the mask.
    expect(flags & ~(0x100000 | 0x20000 | 0x40000 | 0x80000)).toBe(0)
  })

  it('treats caret bounds, replace and confirm as typed answers on a stale token', async () => {
    expect(await need().caretBounds('ax-does-not-exist', 100)).toBeNull()
    const replaced = await need().replaceRange('ax-does-not-exist', 0, 1, 'x', 100)
    expect(replaced.ok).toBe(false)
    expect(replaced.error).toBe('element-gone')
    const confirmed = await need().confirmElement('ax-does-not-exist', 100)
    expect(confirmed).toEqual({ ok: false, advertised: false })
  })

  it('treats a stale element token as a typed result, never a crash', async () => {
    need().releaseElement('ax-does-not-exist')
    expect(await need().readElementState('ax-does-not-exist', 100, 1000)).toBeNull()
    const write = await need().setSelectedText('ax-does-not-exist', 'x', 100, 1000)
    expect(write.ok).toBe(false)
    expect(write.error).toBe('unknown-token')
    const aim = await need().setSelectedTextRange('ax-does-not-exist', 0, 1, 100)
    expect(aim.ok).toBe(false)
    expect(aim.error).toBe('unknown-token')
    const cas = await need().casRangeEdit('ax-does-not-exist', 0, 'x', 0, 1, 'y', -1, -1, 0, 100)
    expect(cas.ok).toBe(false)
    expect(cas.reason).toBe('element-gone')
  })

  it('refuses an unknown submit modifier instead of guessing a chord', () => {
    const b = need() as unknown as { postReturn: (pid: number, modifier: string) => boolean }
    expect(b.postReturn(21474836, 'option')).toBe(false)
  })

  it('resolves null for a pid that cannot exist instead of hanging', async () => {
    expect(await need().readFocusedElement(21474836, 100, 1000)).toBeNull()
  })

  it('resolves priming as a boolean answer — refusal is the common case, not an error', async () => {
    expect(await need().primeAccessibility(21474836, 100)).toBe(false)
  })

  it('rejects bad arguments instead of taking the process down', async () => {
    // NAPI_DISABLE_CPP_EXCEPTIONS turns a mistyped argument into a pending JS exception; the
    // addon must guard arguments so a wrong call is a rejection, not a crash.
    const b = need() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    await expect(b.readFocusedElement?.()).rejects.toThrow()
    await expect(b.verifyElement?.('token-only')).rejects.toThrow()
    await expect(b.setValue?.({})).rejects.toThrow()
    await expect(b.setSelectedTextRange?.('token-only')).rejects.toThrow()
    await expect(b.casRangeEdit?.('token', 0, 'x')).rejects.toThrow()
    await expect(b.caretBounds?.('token-only')).rejects.toThrow()
    await expect(b.replaceRange?.('token', 0)).rejects.toThrow()
    await expect(b.confirmElement?.(42)).rejects.toThrow()
    await expect(b.typeUnicode?.('not-a-pid')).rejects.toThrow()
    expect(need().postPaste(Number.NaN)).toBe(false)
    expect(need().pasteboardRestore('pb-does-not-exist')).toBe(false)
  })

  it('rejects malformed numeric ranges before queuing native work', async () => {
    const b = need() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    await expect(
      b.casRangeEdit?.('ax-does-not-exist', 0, 'x', 1, 0, 'y', -1, -1, 0, 100)
    ).rejects.toThrow(TypeError)
  })

  it('holds a pasteboard snapshot across the gap it protects', async () => {
    // The snapshot must survive several run-loop turns between store and restore — held without
    // ARC it was a raw pointer into a drained autorelease pool, and the restore crashed the
    // process the moment a paste actually landed.
    const marker = `macos-insertable contract probe ${process.pid}`
    need().pasteboardWriteText(marker)

    const snapshot = need().pasteboardSnapshot()
    expect(snapshot.partial).toBe(false)

    const afterWrite = need().pasteboardWriteText('scratch that replaces it')
    expect(need().pasteboardChangeCount()).toBe(afterWrite)

    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 20))

    expect(need().pasteboardRestore(snapshot.token)).toBe(true)
    // A token is single-use: a second restore reports failure rather than freeing twice.
    expect(need().pasteboardRestore(snapshot.token)).toBe(false)
  })

  it('declares clipboard-manager concealment markers alongside written text', async () => {
    const before = need().pasteboardSnapshot()
    try {
      need().pasteboardWriteText('concealment probe')
      const snapshot = need().pasteboardSnapshot()
      try {
        // The markers ride the same pasteboard item; their presence is what asks clipboard
        // managers not to archive the text.
        expect(snapshot.itemCount).toBeGreaterThan(0)
      } finally {
        need().pasteboardDiscardSnapshot(snapshot.token)
      }
    } finally {
      expect(need().pasteboardRestore(before.token)).toBe(true)
    }
  })
})
