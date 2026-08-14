import { describe, expect, it, vi } from 'vitest'
import type { NativeBridge, RawFocusedElement } from '../src/bridge.js'
import { type CapturedField, captureFocusedField } from '../src/capture.js'
import { didTextLand, readCarriesEvidence } from '../src/insert.js'
import { element, fakeBridge, textState } from './fake-bridge.js'

async function capturedWith(
  bridge: NativeBridge,
  overrides: Partial<RawFocusedElement> = {}
): Promise<CapturedField> {
  vi.mocked(bridge.readFocusedElement).mockResolvedValue(element(overrides))
  const captured = await captureFocusedField({ bridge })
  if (captured.status !== 'field') throw new Error(`expected a field, got ${captured.status}`)
  return captured
}

/** An element whose selection cannot be set — classifies as an opaque surface. */
const OPAQUE = { selectedTextSettable: false, hasValue: false, value: '' }

describe('preflight refusals', () => {
  it('refuses empty text', async () => {
    const captured = await capturedWith(fakeBridge())
    expect(await captured.insert('')).toEqual({ delivered: false, reason: 'empty-text' })
  })

  it('refuses when the Accessibility permission was revoked after capture', async () => {
    const bridge = fakeBridge()
    const captured = await capturedWith(bridge)
    vi.mocked(bridge.isAccessibilityTrusted).mockReturnValue(false)
    expect(await captured.insert('x')).toEqual({ delivered: false, reason: 'no-permission' })
  })

  it('refuses under Secure Event Input — a password field is up somewhere', async () => {
    const bridge = fakeBridge()
    const captured = await capturedWith(bridge)
    vi.mocked(bridge.isSecureInputEnabled).mockReturnValue(true)
    expect(await captured.insert('x')).toEqual({ delivered: false, reason: 'secure-input' })
  })

  it('refuses a read-only field', async () => {
    const bridge = fakeBridge()
    const captured = await capturedWith(bridge, {
      valueSettable: false,
      selectedTextSettable: false
    })
    expect(await captured.insert('x')).toEqual({ delivered: false, reason: 'read-only' })
    expect(bridge.setSelectedText).not.toHaveBeenCalled()
    expect(bridge.postPaste).not.toHaveBeenCalled()
  })

  it('refuses a caret insert that would overwrite a captured selection', async () => {
    const captured = await capturedWith(fakeBridge(), {
      selectionStart: 1,
      selectionLength: 3,
      selectedText: 'ell'
    })
    expect(await captured.insert('x', { mode: 'caret' })).toEqual({
      delivered: false,
      reason: 'selection-in-the-way'
    })
  })

  it('refuses a selection replacement when no selection was captured', async () => {
    const captured = await capturedWith(fakeBridge())
    expect(await captured.insert('x', { mode: 'selection' })).toEqual({
      delivered: false,
      reason: 'no-selection'
    })
  })

  it('refuses replace-all on an opaque surface — that is destruction, not an edit', async () => {
    const bridge = fakeBridge()
    const captured = await capturedWith(bridge, OPAQUE)
    expect(await captured.insert('x', { mode: 'all' })).toEqual({
      delivered: false,
      reason: 'unreadable-replace-all'
    })
    expect(bridge.postPaste).not.toHaveBeenCalled()
  })

  it('refuses replace-all on any rung that cannot be verified by read-back', async () => {
    const captured = await capturedWith(fakeBridge())
    expect(await captured.insert('x', { mode: 'all', strategy: 'clipboard' })).toEqual({
      delivered: false,
      reason: 'unreadable-replace-all'
    })
  })

  it('refuses after the user switches applications', async () => {
    const bridge = fakeBridge()
    const captured = await capturedWith(bridge)
    vi.mocked(bridge.frontmostApp).mockReturnValue({ pid: 1, bundleId: 'other', name: 'Other' })
    expect(await captured.insert('x')).toEqual({ delivered: false, reason: 'app-changed' })
  })

  it('refuses when the captured element cannot be re-read', async () => {
    const bridge = fakeBridge({ verifyElement: vi.fn(async () => null) })
    const captured = await capturedWith(bridge)
    expect(await captured.insert('x')).toEqual({ delivered: false, reason: 'element-gone' })
  })

  it('refuses when focus moved to a different element', async () => {
    const bridge = fakeBridge()
    const captured = await capturedWith(bridge)
    vi.mocked(bridge.verifyElement).mockResolvedValue({
      role: 'AXTextField',
      subrole: '',
      title: 'Other',
      description: '',
      placeholder: '',
      identifier: 'other',
      sameElement: false,
      enabled: true
    })
    expect(await captured.insert('x')).toEqual({ delivered: false, reason: 'element-changed' })
  })

  it('refuses when the captured element became disabled', async () => {
    const bridge = fakeBridge()
    const captured = await capturedWith(bridge)
    vi.mocked(bridge.verifyElement).mockResolvedValue({
      role: 'AXTextArea',
      subrole: '',
      title: 'Message',
      description: '',
      placeholder: '',
      identifier: 'compose',
      sameElement: true,
      enabled: false
    })
    expect(await captured.insert('x')).toEqual({ delivered: false, reason: 'element-disabled' })
  })
})

describe('rung 1 — the one-call range replace, preferred where implemented', () => {
  it('replaces through AXReplaceRangeWithText when the element implements it', async () => {
    // AppKit routes this through the input context — native undo, delegate notifications — so
    // it is tried before setting attributes directly.
    const bridge = fakeBridge({
      replaceRange: vi.fn(async () => ({ ok: true, error: null })),
      readElementState: vi
        .fn<NativeBridge['readElementState']>()
        .mockResolvedValueOnce(textState())
        .mockResolvedValue(textState({ value: 'hello world' }))
    })
    const captured = await capturedWith(bridge)
    expect(await captured.insert(' world')).toEqual({ delivered: true, via: 'accessibility' })
    expect(bridge.replaceRange).toHaveBeenCalledWith('ax-1', 5, 0, ' world', expect.any(Number))
    expect(bridge.setSelectedText).not.toHaveBeenCalled()
  })

  it('targets the selection range in selection mode', async () => {
    const bridge = fakeBridge({
      replaceRange: vi.fn(async () => ({ ok: true, error: null })),
      readElementState: vi
        .fn<NativeBridge['readElementState']>()
        .mockResolvedValueOnce(textState({ selectionStart: 1, selectionLength: 3 }))
        .mockResolvedValue(textState({ value: 'hXo' }))
    })
    const captured = await capturedWith(bridge, { selectionStart: 1, selectionLength: 3 })
    await captured.insert('X', { mode: 'selection' })
    expect(bridge.replaceRange).toHaveBeenCalledWith('ax-1', 1, 3, 'X', expect.any(Number))
  })

  it('targets the whole value in replace-all mode', async () => {
    const bridge = fakeBridge({
      replaceRange: vi.fn(async () => ({ ok: true, error: null })),
      readElementState: vi
        .fn<NativeBridge['readElementState']>()
        .mockResolvedValueOnce(textState({ value: 'hello' }))
        .mockResolvedValue(textState({ value: 'replaced' }))
    })
    const captured = await capturedWith(bridge)
    await captured.insert('replaced', { mode: 'all' })
    expect(bridge.replaceRange).toHaveBeenCalledWith('ax-1', 0, 5, 'replaced', expect.any(Number))
  })

  it('falls through to the two-step write where the attribute is inert (Chromium)', async () => {
    // Chromium advertises AXReplaceRangeWithText without implementing it — an ordinary answer,
    // not an error.
    const bridge = fakeBridge()
    const captured = await capturedWith(bridge)
    expect(await captured.insert(' world')).toEqual({ delivered: true, via: 'accessibility' })
    expect(bridge.replaceRange).toHaveBeenCalled()
    expect(bridge.setSelectedText).toHaveBeenCalled()
  })

  it('does not trust a replace that reports success but changed nothing', async () => {
    // The call returns a bare boolean; a wrong parameter key deletes the range and still says
    // yes, so the read-back is what decides.
    const bridge = fakeBridge({
      replaceRange: vi.fn(async () => ({ ok: true, error: null })),
      readElementState: vi.fn(async () => textState())
    })
    const captured = await capturedWith(bridge)
    await captured.insert(' world')
    expect(bridge.setSelectedText).toHaveBeenCalled()
  })
})

describe('spacing: fit', () => {
  /** A bridge whose field holds `value` with the caret at `caret`. */
  function fieldHolding(value: string, caret: number): NativeBridge {
    return fakeBridge({
      readElementState: vi.fn(async () =>
        textState({ value, selectionStart: caret, selectionLength: 0 })
      )
    })
  }

  it('separates the insertion from the word before it', async () => {
    const bridge = fieldHolding('Hello', 5)
    const captured = await capturedWith(bridge, { value: 'Hello', selectionStart: 5 })
    await captured.insert('world', { spacing: 'fit' })
    expect(bridge.setSelectedText).toHaveBeenCalledWith(
      'ax-1',
      ' world',
      expect.any(Number),
      expect.any(Number)
    )
  })

  it('inserts exactly what it was given by default', async () => {
    const bridge = fieldHolding('Hello', 5)
    const captured = await capturedWith(bridge, { value: 'Hello', selectionStart: 5 })
    await captured.insert('world')
    expect(bridge.setSelectedText).toHaveBeenCalledWith(
      'ax-1',
      'world',
      expect.any(Number),
      expect.any(Number)
    )
  })

  it('judges against the LIVE field, not the state captured seconds ago', async () => {
    // The user dictated once already; the separator must be judged against what that left.
    const bridge = fieldHolding('Hello world', 11)
    const captured = await capturedWith(bridge, { value: 'Hello', selectionStart: 5 })
    await captured.insert('again', { spacing: 'fit' })
    expect(bridge.setSelectedText).toHaveBeenCalledWith(
      'ax-1',
      ' again',
      expect.any(Number),
      expect.any(Number)
    )
  })

  it('adds nothing when the field already ends in whitespace', async () => {
    const bridge = fieldHolding('Hello ', 6)
    const captured = await capturedWith(bridge, { value: 'Hello ', selectionStart: 6 })
    await captured.insert('world', { spacing: 'fit' })
    expect(bridge.setSelectedText).toHaveBeenCalledWith(
      'ax-1',
      'world',
      expect.any(Number),
      expect.any(Number)
    )
  })

  it('separates on both sides when the caret sits mid-text', async () => {
    const bridge = fieldHolding('Helloworld', 5)
    const captured = await capturedWith(bridge, { value: 'Helloworld', selectionStart: 5 })
    await captured.insert('brave', { spacing: 'fit' })
    expect(bridge.setSelectedText).toHaveBeenCalledWith(
      'ax-1',
      ' brave ',
      expect.any(Number),
      expect.any(Number)
    )
  })

  it('leaves an opaque surface untouched — there is no context to fit to', async () => {
    const bridge = fakeBridge({
      setSelectedText: vi.fn(async () => ({ ok: false, error: 'refused', after: null })),
      readElementState: vi
        .fn<NativeBridge['readElementState']>()
        .mockResolvedValueOnce(textState())
        .mockResolvedValue(textState({ value: 'hello world' }))
    })
    const captured = await capturedWith(bridge, OPAQUE)
    await captured.insert('world', { spacing: 'fit' })
    expect(bridge.pasteboardWriteText).toHaveBeenCalledWith('world')
  })

  it('does not fit a whole-field replacement — it replaces the surroundings', async () => {
    const bridge = fieldHolding('Hello', 5)
    const captured = await capturedWith(bridge, { value: 'Hello', selectionStart: 5 })
    await captured.insert('replaced', { mode: 'all', spacing: 'fit' })
    expect(bridge.setValue).toHaveBeenCalledWith(
      'ax-1',
      'replaced',
      expect.any(Number),
      expect.any(Number)
    )
  })
})

describe('modifier gate before synthetic input', () => {
  it('refuses to post a paste while the user still holds a chord', async () => {
    const bridge = fakeBridge({
      setSelectedText: vi.fn(async () => ({ ok: false, error: 'refused', after: null })),
      currentModifierFlags: vi.fn(() => 0x100000)
    })
    const captured = await capturedWith(bridge)
    expect(await captured.insert(' world', { waitForModifiersMs: 1 })).toEqual({
      delivered: false,
      reason: 'modifiers-held'
    })
    expect(bridge.postPaste).not.toHaveBeenCalled()
  })

  it('never gates the accessibility rung — it posts no events', async () => {
    const bridge = fakeBridge({ currentModifierFlags: vi.fn(() => 0x100000) })
    const captured = await capturedWith(bridge)
    expect(await captured.insert(' world')).toEqual({ delivered: true, via: 'accessibility' })
  })
})

describe('rung 1 — verified accessibility write', () => {
  it('delivers a caret insert through setSelectedText and verifies in the same trip', async () => {
    const bridge = fakeBridge()
    const captured = await capturedWith(bridge)
    expect(await captured.insert(' world')).toEqual({ delivered: true, via: 'accessibility' })
    expect(bridge.setSelectedText).toHaveBeenCalledWith(
      'ax-1',
      ' world',
      expect.any(Number),
      expect.any(Number)
    )
    expect(bridge.postPaste).not.toHaveBeenCalled()
  })

  it('delivers replace-all through setValue', async () => {
    const bridge = fakeBridge()
    const captured = await capturedWith(bridge)
    expect(await captured.insert('replaced', { mode: 'all' })).toEqual({
      delivered: true,
      via: 'accessibility'
    })
    expect(bridge.setValue).toHaveBeenCalled()
  })

  it('accepts a write the application asynchronously mirrors after a settle', async () => {
    // Chromium-backed apps round-trip to their renderer: the same-trip read still shows the OLD
    // text. Treating that as failure sent every such app to the paste rung.
    const bridge = fakeBridge({
      setSelectedText: vi.fn(async () => ({ ok: true, error: null, after: textState() })),
      readElementState: vi
        .fn<NativeBridge['readElementState']>()
        .mockResolvedValueOnce(textState())
        .mockResolvedValueOnce(textState())
        .mockResolvedValue(textState({ value: 'hello world' }))
    })
    const captured = await capturedWith(bridge)
    expect(await captured.insert(' world')).toEqual({ delivered: true, via: 'accessibility' })
  })

  it('falls through to paste when the write is rejected', async () => {
    const bridge = fakeBridge({
      setSelectedText: vi.fn(async () => ({ ok: false, error: 'ax-error-1', after: null })),
      // Reads, in order: the accessibility rung's before, the paste rung's before, then the
      // paste verification seeing the grown value.
      readElementState: vi
        .fn<NativeBridge['readElementState']>()
        .mockResolvedValueOnce(textState())
        .mockResolvedValueOnce(textState())
        .mockResolvedValue(textState({ value: 'hello world' }))
    })
    const captured = await capturedWith(bridge)
    expect(await captured.insert(' world')).toEqual({ delivered: true, via: 'clipboard' })
    expect(bridge.postPaste).toHaveBeenCalled()
  })

  it('refuses replace-all rather than falling to an inexact rung when unverified', async () => {
    const bridge = fakeBridge({
      setValue: vi.fn(async () => ({ ok: true, error: null, after: textState() })),
      readElementState: vi.fn(async () => textState())
    })
    const captured = await capturedWith(bridge)
    expect(await captured.insert('replaced', { mode: 'all' })).toEqual({
      delivered: false,
      reason: 'unreadable-replace-all'
    })
    expect(bridge.postPaste).not.toHaveBeenCalled()
  })
})

describe('rung 2 — borrowed clipboard paste', () => {
  function pasteBridge(overrides: Partial<NativeBridge> = {}): NativeBridge {
    return fakeBridge({
      setSelectedText: vi.fn(async () => ({ ok: false, error: 'refused', after: null })),
      readElementState: vi
        .fn<NativeBridge['readElementState']>()
        .mockResolvedValueOnce(textState())
        .mockResolvedValueOnce(textState())
        .mockResolvedValue(textState({ value: 'hello world' })),
      ...overrides
    })
  }

  it('borrows the pasteboard and puts it back', async () => {
    const bridge = pasteBridge()
    const captured = await capturedWith(bridge)
    expect(await captured.insert(' world')).toEqual({ delivered: true, via: 'clipboard' })
    expect(bridge.pasteboardSnapshot).toHaveBeenCalled()
    expect(bridge.pasteboardWriteText).toHaveBeenCalledWith(' world')
    expect(bridge.pasteboardRestore).toHaveBeenCalledWith('pb-1')
  })

  it('leaves a newer user copy alone instead of restoring over it', async () => {
    const bridge = pasteBridge({
      // The user copied something after our write: the change count moved past ours.
      pasteboardChangeCount: vi.fn(() => 9)
    })
    const captured = await capturedWith(bridge)
    expect(await captured.insert(' world')).toEqual({ delivered: true, via: 'clipboard' })
    expect(bridge.pasteboardRestore).not.toHaveBeenCalled()
    expect(bridge.pasteboardDiscardSnapshot).toHaveBeenCalledWith('pb-1')
  })

  it('reports paste-not-posted when the target application lost frontmost', async () => {
    const bridge = pasteBridge({ postPaste: vi.fn(() => false) })
    const captured = await capturedWith(bridge)
    expect(await captured.insert(' world')).toEqual({
      delivered: false,
      reason: 'paste-not-posted'
    })
    // The text is deliberately left on the pasteboard: content the user can still paste by hand
    // beats content that vanished.
    expect(bridge.pasteboardRestore).not.toHaveBeenCalled()
  })

  it('reports paste-did-not-land only on positive evidence', async () => {
    const bridge = pasteBridge({
      readElementState: vi.fn(async () => textState({ value: 'hello' }))
    })
    const captured = await capturedWith(bridge)
    expect(await captured.insert(' world')).toEqual({
      delivered: false,
      reason: 'paste-did-not-land'
    })
  })

  it('trusts the paste when the field cannot bear witness', async () => {
    // Empty before and after: indistinguishable from an editor that never mirrors its document.
    const bridge = pasteBridge({
      readElementState: vi.fn(async () => textState({ value: '' }))
    })
    const captured = await capturedWith(bridge, { value: '' })
    expect(await captured.insert(' world')).toEqual({ delivered: true, via: 'clipboard' })
  })

  it('deletes the live selection before pasting a replacement into an opaque editor', async () => {
    const calls: string[] = []
    const bridge = fakeBridge({
      postBackspace: vi.fn(() => {
        calls.push('backspace')
        return true
      }),
      postPaste: vi.fn(() => {
        calls.push('paste')
        return true
      })
    })
    const captured = await capturedWith(bridge, {
      ...OPAQUE,
      selectionStart: 1,
      selectionLength: 3
    })
    expect(await captured.insert('x', { mode: 'selection' })).toEqual({
      delivered: true,
      via: 'clipboard'
    })
    expect(calls).toEqual(['backspace', 'paste'])
  })

  it('serializes overlapping borrows so one insertion cannot snapshot another’s text', async () => {
    const events: string[] = []
    function tracked(token: string): NativeBridge {
      return fakeBridge({
        setSelectedText: vi.fn(async () => ({ ok: false, error: 'refused', after: null })),
        readElementState: vi
          .fn<NativeBridge['readElementState']>()
          .mockResolvedValueOnce(textState())
          .mockResolvedValueOnce(textState())
          .mockResolvedValue(textState({ value: 'hello world' })),
        pasteboardSnapshot: vi.fn(() => {
          events.push(`snapshot:${token}`)
          return { token, changeCount: 1, itemCount: 1, partial: false }
        }),
        pasteboardRestore: vi.fn((restored: string) => {
          events.push(`restore:${restored}`)
          return true
        })
      })
    }

    const first = await capturedWith(tracked('pb-first'))
    const second = await capturedWith(tracked('pb-second'))
    const [a, b] = await Promise.all([first.insert(' one'), second.insert(' two')])
    expect(a).toEqual({ delivered: true, via: 'clipboard' })
    expect(b).toEqual({ delivered: true, via: 'clipboard' })
    expect(events).toEqual([
      'snapshot:pb-first',
      'restore:pb-first',
      'snapshot:pb-second',
      'restore:pb-second'
    ])
  })
})

describe('rung 3 — synthetic keystrokes', () => {
  it('types when the pasteboard cannot be captured completely', async () => {
    const bridge = fakeBridge({
      setSelectedText: vi.fn(async () => ({ ok: false, error: 'refused', after: null })),
      readElementState: vi.fn(async () => textState()),
      pasteboardSnapshot: vi.fn(() => ({
        token: 'pb-1',
        changeCount: 1,
        itemCount: 3,
        partial: true
      }))
    })
    const captured = await capturedWith(bridge)
    expect(await captured.insert(' world')).toEqual({ delivered: true, via: 'keystrokes' })
    expect(bridge.pasteboardDiscardSnapshot).toHaveBeenCalledWith('pb-1')
    expect(bridge.postPaste).not.toHaveBeenCalled()
  })

  it('honours a forced keystrokes strategy without touching the other rungs', async () => {
    const bridge = fakeBridge()
    const captured = await capturedWith(bridge)
    expect(await captured.insert('x', { strategy: 'keystrokes' })).toEqual({
      delivered: true,
      via: 'keystrokes'
    })
    expect(bridge.setSelectedText).not.toHaveBeenCalled()
    expect(bridge.pasteboardSnapshot).not.toHaveBeenCalled()
  })

  it('honours a forced clipboard strategy without an accessibility attempt', async () => {
    const bridge = fakeBridge({
      readElementState: vi
        .fn<NativeBridge['readElementState']>()
        .mockResolvedValueOnce(textState())
        .mockResolvedValue(textState({ value: 'hello world' }))
    })
    const captured = await capturedWith(bridge)
    expect(await captured.insert(' world', { strategy: 'clipboard' })).toEqual({
      delivered: true,
      via: 'clipboard'
    })
    expect(bridge.setSelectedText).not.toHaveBeenCalled()
  })

  it('reports type-failed when the events were not delivered', async () => {
    const bridge = fakeBridge({ typeUnicode: vi.fn(async () => false) })
    const captured = await capturedWith(bridge)
    expect(await captured.insert('x', { strategy: 'keystrokes' })).toEqual({
      delivered: false,
      reason: 'type-failed'
    })
  })

  it('refuses to type a selection replacement into an opaque editor', async () => {
    // Backspace and payload must be adjacent posts; chunked typing cannot guarantee that.
    const bridge = fakeBridge()
    const captured = await capturedWith(bridge, {
      ...OPAQUE,
      selectionStart: 1,
      selectionLength: 3
    })
    expect(await captured.insert('x', { mode: 'selection', strategy: 'keystrokes' })).toEqual({
      delivered: false,
      reason: 'type-failed'
    })
    expect(bridge.typeUnicode).not.toHaveBeenCalled()
  })
})

describe('verification helpers', () => {
  it('didTextLand accepts application normalization by length delta, not equality', () => {
    expect(
      didTextLand(textState({ value: 'a' }), textState({ value: 'a b!' }), ' b', 'caret')
    ).toBe(true)
  })

  it('didTextLand rejects an unchanged field', () => {
    expect(didTextLand(textState(), textState(), ' world', 'caret')).toBe(false)
  })

  it('didTextLand accepts a replace-all that changed the value at all', () => {
    expect(
      didTextLand(textState({ value: 'old' }), textState({ value: 'New.' }), 'new', 'all')
    ).toBe(true)
  })

  it('didTextLand accepts a plausible end state when there was nothing to compare against', () => {
    expect(didTextLand(null, textState({ value: 'anything' }), 'x', 'caret')).toBe(true)
    expect(didTextLand(null, textState({ value: '' }), 'x', 'caret')).toBe(false)
  })

  it('readCarriesEvidence requires text on at least one side of the paste', () => {
    expect(readCarriesEvidence(textState({ value: '' }), textState({ value: '' }))).toBe(false)
    expect(readCarriesEvidence(textState({ value: 'a' }), textState({ value: '' }))).toBe(true)
    expect(readCarriesEvidence(textState({ value: '' }), textState({ value: 'a' }))).toBe(true)
    expect(readCarriesEvidence(textState(), null)).toBe(false)
    expect(readCarriesEvidence(textState(), textState({ hasValue: false }))).toBe(false)
  })
})
