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

/** A field whose value the fake tracks, so range edits behave like a real text view. */
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
    setSelectedTextRange: vi.fn(async (_token: string, start: number, length: number) => {
      selStart = start
      selLength = length
      return { ok: true, error: null, selectionStart: start, selectionLength: length }
    }),
    setSelectedText: vi.fn(async (_token: string, text: string) => {
      value = value.slice(0, selStart) + text + value.slice(selStart + selLength)
      selStart += text.length
      selLength = 0
      return { ok: true, error: null, after: state() }
    })
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

    // The second update selected the empty tail [5,5) and wrote only " world".
    expect(vi.mocked(bridge.setSelectedText).mock.calls.map((call) => call[1])).toEqual([
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
    expect(vi.mocked(bridge.setSelectedText).mock.calls.at(-1)?.[1]).toBe("y're")
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

  it('equal text is a free no-op — no writes at all', async () => {
    const bridge = liveFieldBridge('', 0)
    const draft = await draftOn(bridge)
    await draft.update('same')
    const writes = vi.mocked(bridge.setSelectedText).mock.calls.length
    expect(await draft.update('same')).toEqual({ delivered: true })
    expect(vi.mocked(bridge.setSelectedText).mock.calls.length).toBe(writes)
  })

  it('parks the caret at the end of the draft after every update', async () => {
    const bridge = liveFieldBridge('', 0)
    const draft = await draftOn(bridge)
    await draft.update('their home')
    await draft.update('they home')
    // Last range call is the caret park at the draft's end, not the edit aim.
    const lastRange = vi.mocked(bridge.setSelectedTextRange).mock.calls.at(-1)
    expect(lastRange?.[1]).toBe(9)
    expect(lastRange?.[2]).toBe(0)
  })
})

describe('Draft.update — refusals', () => {
  it('refuses with draft-drifted when the user edited the region', async () => {
    const bridge = liveFieldBridge('', 0)
    const draft = await draftOn(bridge)
    await draft.update('hello world')

    // The user backspaces over our text between updates:
    vi.mocked(bridge.readElementState).mockResolvedValue(
      textState({ value: 'hello wor', selectionStart: 9, selectionLength: 0 })
    )
    expect(await draft.update('hello world again')).toEqual({
      delivered: false,
      reason: 'draft-drifted'
    })
  })

  it('refuses when the user switched applications mid-stream', async () => {
    const bridge = liveFieldBridge('', 0)
    const draft = await draftOn(bridge)
    vi.mocked(bridge.frontmostApp).mockReturnValue({ pid: 1, bundleId: 'other', name: 'Other' })
    expect(await draft.update('x')).toEqual({ delivered: false, reason: 'app-changed' })
  })

  it('refuses when the range could not be aimed where asked', async () => {
    const bridge = liveFieldBridge('', 0)
    const draft = await draftOn(bridge)
    vi.mocked(bridge.setSelectedTextRange).mockResolvedValue({
      ok: true,
      error: null,
      // The view answered with a different selection than requested — writing now would land
      // the replacement somewhere else.
      selectionStart: 3,
      selectionLength: 2
    })
    expect(await draft.update('hello')).toMatchObject({ delivered: false })
  })

  it('refuses under secure input', async () => {
    const bridge = liveFieldBridge('', 0)
    const draft = await draftOn(bridge)
    vi.mocked(bridge.isSecureInputEnabled).mockReturnValue(true)
    expect(await draft.update('x')).toEqual({ delivered: false, reason: 'secure-input' })
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
