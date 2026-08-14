import { describe, expect, it, vi } from 'vitest'

import type { NativeBridge } from '../src/bridge.js'
import { captureFocusedField } from '../src/capture.js'
import type { Draft } from '../src/draft.js'
import { minimalEdit } from '../src/draft.js'
import { element, fakeBridge, textState } from './fake-bridge.js'

describe('minimalEdit', () => {
  it('returns null for equal text — a free no-op', () => {
    expect(minimalEdit('same', 'same')).toBeNull()
  })

  it('finds a pure append', () => {
    expect(minimalEdit('hello', 'hello world')).toEqual({
      start: 5,
      end: 5,
      replacement: ' world'
    })
  })

  it('finds a single changed word inside a paragraph', () => {
    // "their" → "they're": shared "the" prefix and " going home now" suffix survive untouched.
    expect(minimalEdit('their going home now', "they're going home now")).toEqual({
      start: 3,
      end: 5,
      replacement: "y're"
    })
  })

  it('finds a deletion', () => {
    expect(minimalEdit('one two three', 'one three')).toEqual({
      start: 5,
      end: 9,
      replacement: ''
    })
  })

  it('replaces everything when nothing is shared', () => {
    expect(minimalEdit('abc', 'xyz')).toEqual({ start: 0, end: 3, replacement: 'xyz' })
  })

  it('empties the whole text', () => {
    expect(minimalEdit('scratch that', '')).toEqual({ start: 0, end: 12, replacement: '' })
  })

  it('grows from empty', () => {
    expect(minimalEdit('', 'first words')).toEqual({ start: 0, end: 0, replacement: 'first words' })
  })

  it('never splits a surrogate pair at the prefix boundary', () => {
    // 😀 and 😁 share a high surrogate; a naive prefix would cut between the pair's halves.
    const edit = minimalEdit('a😀', 'a😁')
    if (!edit) throw new Error('expected an edit')
    expect(edit).toEqual({ start: 1, end: 3, replacement: '😁' })
    // The boundaries land on whole characters — both slices survive a round trip.
    expect(() => JSON.stringify('a😀'.slice(edit.start, edit.end).toWellFormed())).not.toThrow()
  })

  it('never splits a surrogate pair at the suffix boundary', () => {
    const edit = minimalEdit('😀z', '😁z')
    if (!edit) throw new Error('expected an edit')
    expect(edit).toEqual({ start: 0, end: 2, replacement: '😁' })
  })

  it('applies cleanly: before + edit === after', () => {
    const cases: Array<[string, string]> = [
      ['hello', 'hello world'],
      ['their going', "they're going"],
      ['a b c', 'a c'],
      ['', 'x'],
      ['x', ''],
      ['aaa', 'aaaa'],
      ['😀😀', '😀😁😀']
    ]
    for (const [before, after] of cases) {
      const edit = minimalEdit(before, after)
      if (!edit) {
        expect(before).toBe(after)
        continue
      }
      const applied = before.slice(0, edit.start) + edit.replacement + before.slice(edit.end)
      expect(applied).toBe(after)
    }
  })
})

/**
 * A field whose value the fake tracks, implementing the fused compare-and-swap the way the
 * native side does — region compare, splice, conditional caret park — so draft behavior is
 * exercised against the real contract.
 */
function liveFieldBridge(initial: string, caret: number, selectionLength = 0): NativeBridge {
  let value = initial
  let selStart = caret
  let selLength = selectionLength
  const state = () =>
    textState({
      value,
      selectedText: value.slice(selStart, selStart + selLength),
      selectionStart: selStart,
      selectionLength: selLength,
      numberOfCharacters: value.length
    })
  return fakeBridge({
    readFocusedElement: vi.fn(async () => element({ ...state() })),
    readElementState: vi.fn(async () => state()),
    casRangeEdit: vi.fn(
      async (
        _token: string,
        regionStart: number,
        expected: string,
        editStart: number,
        editEnd: number,
        replacement: string,
        parkAt: number,
        expectedCaret: number
      ) => {
        if (value.slice(regionStart, regionStart + expected.length) !== expected) {
          return { ok: false, reason: 'region-mismatch', parked: false, via: null }
        }
        const caretIsOurs = expectedCaret < 0 || (selLength === 0 && selStart === expectedCaret)
        value =
          value.slice(0, regionStart + editStart) + replacement + value.slice(regionStart + editEnd)
        selStart = regionStart + editStart + replacement.length
        selLength = 0
        let parked = false
        if (parkAt >= 0 && caretIsOurs) {
          selStart = parkAt
          parked = true
        }
        return { ok: true, reason: null, parked, via: 'selected-text' }
      }
    )
  })
}

async function draftOn(bridge: NativeBridge): Promise<Draft> {
  const captured = await captureFocusedField({ bridge })
  if (captured.status !== 'field') throw new Error('expected a field')
  const started = await captured.startDraft()
  if (!started.ok) throw new Error(`draft refused: ${started.reason}`)
  return started.draft
}

describe('startDraft', () => {
  it('anchors at the live caret, not the captured one', async () => {
    const bridge = liveFieldBridge('hello world', 5)
    const draft = await draftOn(bridge)
    expect(draft.range).toEqual({ start: 5, end: 5 })
    expect(draft.text).toBe('')
  })

  it('starts over the live selection so the first update replaces it', async () => {
    const bridge = liveFieldBridge('hello world', 6, 5)
    const draft = await draftOn(bridge)
    expect(draft.range).toEqual({ start: 6, end: 11 })
    expect(draft.text).toBe('world')
  })

  it('refuses on an opaque surface — range edits need read-back', async () => {
    const bridge = fakeBridge({
      readFocusedElement: vi.fn(async () => element({ selectedTextSettable: false }))
    })
    const captured = await captureFocusedField({ bridge })
    if (captured.status !== 'field') throw new Error('expected a field')
    expect(await captured.startDraft()).toEqual({ ok: false, reason: 'opaque-surface' })
  })

  it('refuses after release', async () => {
    const captured = await captureFocusedField({ bridge: liveFieldBridge('x', 1) })
    if (captured.status !== 'field') throw new Error('expected a field')
    captured.release()
    expect(await captured.startDraft()).toEqual({ ok: false, reason: 'released' })
  })

  it('refuses when the element reports no caret', async () => {
    const bridge = liveFieldBridge('hello', 0)
    vi.mocked(bridge.readElementState).mockResolvedValue(
      textState({ selectionStart: null, selectionLength: null })
    )
    const captured = await captureFocusedField({ bridge })
    if (captured.status !== 'field') throw new Error('expected a field')
    expect(await captured.startDraft()).toEqual({ ok: false, reason: 'no-caret' })
  })
})

describe('Draft.update — the streaming transcription flow', () => {
  it('streams partials as diff-minimal edits and lands the final text', async () => {
    const bridge = liveFieldBridge('note: ', 6)
    const draft = await draftOn(bridge)

    expect(await draft.update('call')).toEqual({ delivered: true })
    expect(await draft.update('call mom')).toEqual({ delivered: true })
    expect(await draft.update('call mom tomorrow')).toEqual({ delivered: true })

    const final = await bridge.readElementState('ax-1', 0, 1000)
    expect(final?.value).toBe('note: call mom tomorrow')
    expect(draft.range).toEqual({ start: 6, end: 23 })
  })

  it('appends touch only the tail — the diff never rewrites what stands', async () => {
    const bridge = liveFieldBridge('', 0)
    const draft = await draftOn(bridge)
    await draft.update('hello')
    await draft.update('hello world')

    // The second trip carried only " world" as its replacement span.
    expect(vi.mocked(bridge.casRangeEdit).mock.calls.map((call) => call[5])).toEqual([
      'hello',
      ' world'
    ])
  })

  it('revises one word in place when a correction lands', async () => {
    const bridge = liveFieldBridge('', 0)
    const draft = await draftOn(bridge)
    await draft.update('their going home now')
    expect(await draft.update("they're going home now")).toEqual({ delivered: true })

    const final = await bridge.readElementState('ax-1', 0, 1000)
    expect(final?.value).toBe("they're going home now")
    // Only the changed span travelled.
    expect(vi.mocked(bridge.casRangeEdit).mock.calls.at(-1)?.[5]).toBe("y're")
  })

  it('spends exactly one native trip per update', async () => {
    const bridge = liveFieldBridge('', 0)
    const draft = await draftOn(bridge)
    // startDraft's one-time setup traffic ends here; the hot path begins.
    const verifies = vi.mocked(bridge.verifyElement).mock.calls.length
    const frontmosts = vi.mocked(bridge.frontmostApp).mock.calls.length
    const reads = vi.mocked(bridge.readElementState).mock.calls.length

    await draft.update('hello')
    await draft.update('hello world')
    await draft.update('hello world')

    // Two real edits, one no-op — and no other bridge traffic at all: the fused trip IS the
    // update.
    expect(vi.mocked(bridge.casRangeEdit).mock.calls.length).toBe(2)
    expect(vi.mocked(bridge.verifyElement).mock.calls.length).toBe(verifies)
    expect(vi.mocked(bridge.frontmostApp).mock.calls.length).toBe(frontmosts)
    expect(vi.mocked(bridge.readElementState).mock.calls.length).toBe(reads)
    expect(bridge.setSelectedText).not.toHaveBeenCalled()
  })

  it('replaces the selection the draft was started over', async () => {
    const bridge = liveFieldBridge('fix THIS PART please', 4, 9)
    const draft = await draftOn(bridge)
    expect(draft.text).toBe('THIS PART')
    await draft.update('that section')

    const final = await bridge.readElementState('ax-1', 0, 1000)
    expect(final?.value).toBe('fix that section please')
  })

  it('update("") is scratch-that — the region empties and stays owned', async () => {
    const bridge = liveFieldBridge('keep ', 5)
    const draft = await draftOn(bridge)
    await draft.update('umm delete all this')
    expect(await draft.update('')).toEqual({ delivered: true })

    const final = await bridge.readElementState('ax-1', 0, 1000)
    expect(final?.value).toBe('keep ')
    // Still anchored: a follow-up dictation lands in the same spot.
    expect(await draft.update('the real sentence')).toEqual({ delivered: true })
    expect((await bridge.readElementState('ax-1', 0, 1000))?.value).toBe('keep the real sentence')
  })

  it('equal text is a free no-op — no native trip at all', async () => {
    const bridge = liveFieldBridge('', 0)
    const draft = await draftOn(bridge)
    await draft.update('same')
    const trips = vi.mocked(bridge.casRangeEdit).mock.calls.length
    expect(await draft.update('same')).toEqual({ delivered: true })
    expect(vi.mocked(bridge.casRangeEdit).mock.calls.length).toBe(trips)
  })

  it('asks each trip to park the caret at the end of the draft', async () => {
    const bridge = liveFieldBridge('', 0)
    const draft = await draftOn(bridge)
    await draft.update('their home')
    await draft.update('they home')
    // parkAt rides the fused trip; the second one also names where the first left the caret.
    const calls = vi.mocked(bridge.casRangeEdit).mock.calls
    expect(calls[0]?.[6]).toBe(10) // park at end of "their home"
    expect(calls[0]?.[7]).toBe(-1) // first write: caret unconditionally ours
    expect(calls[1]?.[6]).toBe(9)
    expect(calls[1]?.[7]).toBe(10) // must still be where the first update parked it
  })

  it('stops parking once the user moves the caret away', async () => {
    const bridge = liveFieldBridge('', 0)
    const draft = await draftOn(bridge)
    await draft.update('hello')
    // The fake reports the park was skipped — the live caret was not where we left it.
    vi.mocked(bridge.casRangeEdit).mockResolvedValueOnce({
      ok: true,
      reason: null,
      parked: false,
      via: 'selected-text'
    })
    await draft.update('hello there')
    await draft.update('hello there friend')
    // expectedCaret stays at the LAST position we parked, so parking resumes only if the user
    // returns the caret there.
    expect(vi.mocked(bridge.casRangeEdit).mock.calls.at(-1)?.[7]).toBe(5)
  })
})

describe('Draft.update — refusals', () => {
  it('refuses with draft-drifted when the user edited the region', async () => {
    const bridge = liveFieldBridge('', 0)
    const draft = await draftOn(bridge)
    await draft.update('hello world')

    // The user backspaced over our text between updates; the region compare fails natively.
    vi.mocked(bridge.casRangeEdit).mockResolvedValue({
      ok: false,
      reason: 'region-mismatch',
      parked: false,
      via: null
    })
    expect(await draft.update('hello world again')).toEqual({
      delivered: false,
      reason: 'draft-drifted'
    })
  })

  it('keeps streaming when the app is merely backgrounded — the region check is the guard', async () => {
    // An Accessibility write lands on the element it references; there is no misdirection for
    // a frontmost check to prevent, and pausing dictation because the user glanced at another
    // window would be a bug, not a safety feature.
    const bridge = liveFieldBridge('', 0)
    const draft = await draftOn(bridge)
    vi.mocked(bridge.frontmostApp).mockReturnValue({ pid: 1, bundleId: 'other', name: 'Other' })
    expect(await draft.update('still streaming')).toEqual({ delivered: true })
  })

  it('refuses when focus moved to a different element', async () => {
    const bridge = liveFieldBridge('', 0)
    const draft = await draftOn(bridge)
    vi.mocked(bridge.casRangeEdit).mockResolvedValue({
      ok: false,
      reason: 'element-changed',
      parked: false,
      via: null
    })
    expect(await draft.update('x')).toEqual({ delivered: false, reason: 'element-changed' })
  })

  it('refuses when the range could not be aimed where asked', async () => {
    const bridge = liveFieldBridge('', 0)
    const draft = await draftOn(bridge)
    vi.mocked(bridge.casRangeEdit).mockResolvedValue({
      ok: false,
      reason: 'select-failed',
      parked: false,
      via: null
    })
    expect(await draft.update('hello')).toEqual({
      delivered: false,
      reason: 'range-write-failed'
    })
  })

  it('refuses under secure input without a native trip', async () => {
    const bridge = liveFieldBridge('', 0)
    const draft = await draftOn(bridge)
    vi.mocked(bridge.isSecureInputEnabled).mockReturnValue(true)
    expect(await draft.update('x')).toEqual({ delivered: false, reason: 'secure-input' })
    expect(bridge.casRangeEdit).not.toHaveBeenCalled()
  })
})

describe('submit', () => {
  it('posts the send chord after re-proving the element', async () => {
    const bridge = liveFieldBridge('done', 4)
    const captured = await captureFocusedField({ bridge })
    if (captured.status !== 'field') throw new Error('expected a field')
    expect(await captured.submit()).toEqual({ submitted: true })
    expect(bridge.postReturn).toHaveBeenCalledWith(4242, 'none')
  })

  it('passes the modifier for apps whose send chord differs', async () => {
    const bridge = liveFieldBridge('done', 4)
    const captured = await captureFocusedField({ bridge })
    if (captured.status !== 'field') throw new Error('expected a field')
    await captured.submit('command')
    expect(bridge.postReturn).toHaveBeenCalledWith(4242, 'command')
  })

  it('refuses rather than pressing Enter in a different application', async () => {
    const bridge = liveFieldBridge('done', 4)
    const captured = await captureFocusedField({ bridge })
    if (captured.status !== 'field') throw new Error('expected a field')
    vi.mocked(bridge.frontmostApp).mockReturnValue({ pid: 1, bundleId: 'other', name: 'Other' })
    expect(await captured.submit()).toEqual({ submitted: false, reason: 'app-changed' })
    expect(bridge.postReturn).not.toHaveBeenCalled()
  })

  it('refuses after release', async () => {
    const captured = await captureFocusedField({ bridge: liveFieldBridge('x', 1) })
    if (captured.status !== 'field') throw new Error('expected a field')
    captured.release()
    expect(await captured.submit()).toEqual({ submitted: false, reason: 'released' })
  })
})
