import { describe, expect, it, vi } from 'vitest'

import { captureFocusedField, readFocusedField } from '../src/capture.js'
import { checkAccess, insertText } from '../src/index.js'
import { APP, element, fakeBridge, textState } from './fake-bridge.js'

describe('checkAccess', () => {
  it('answers with the real loader without throwing on any platform', () => {
    // On macOS with the addon built this is fully supported; off it, an inert 'unsupported'.
    expect(checkAccess()).toMatchObject({ supported: expect.any(Boolean) })
  })

  it('reports permission and secure-input state from the bridge', () => {
    const bridge = fakeBridge({ isSecureInputEnabled: vi.fn(() => true) })
    expect(checkAccess({ bridge })).toEqual({
      supported: true,
      trusted: true,
      secureInput: true,
      secureInputHolder: null
    })
  })

  it('names the application holding secure input so the refusal can be actionable', () => {
    const holder = { pid: 501, name: '1Password', bundleId: 'com.1password.1password' }
    const bridge = fakeBridge({
      isSecureInputEnabled: vi.fn(() => true),
      secureInputCulprit: vi.fn(() => holder)
    })
    expect(checkAccess({ bridge }).secureInputHolder).toEqual(holder)
  })

  it('does not go looking for a holder when secure input is off', () => {
    // A null answer would otherwise be ambiguous between "nobody holds it" and "the OS would
    // not say" — and the lookup walks the IO registry for nothing.
    const bridge = fakeBridge()
    expect(checkAccess({ bridge }).secureInputHolder).toBeNull()
    expect(bridge.secureInputCulprit).not.toHaveBeenCalled()
  })
})

describe('captureFocusedField', () => {
  it('refuses without the Accessibility permission', async () => {
    const bridge = fakeBridge({ isAccessibilityTrusted: vi.fn(() => false) })
    expect(await captureFocusedField({ bridge })).toEqual({ status: 'no-permission' })
  })

  it('reports no-element when the application shows nothing focused', async () => {
    const bridge = fakeBridge({ readFocusedElement: vi.fn(async () => null) })
    expect(await captureFocusedField({ bridge })).toEqual({ status: 'no-element', app: APP })
  })

  it('reports no-element when the read rejects', async () => {
    const bridge = fakeBridge({
      readFocusedElement: vi.fn(async () => {
        throw new Error('wedged')
      })
    })
    expect(await captureFocusedField({ bridge })).toEqual({ status: 'no-element', app: APP })
  })

  it('releases the element when the focused control is not a field', async () => {
    const bridge = fakeBridge({
      readFocusedElement: vi.fn(async () =>
        element({ role: 'AXButton', attributeNames: ['AXRole'] })
      )
    })
    const result = await captureFocusedField({ bridge })
    expect(result).toMatchObject({ status: 'not-a-field', role: 'AXButton', app: APP })
    expect(bridge.releaseElement).toHaveBeenCalledWith('ax-1')
  })

  it('releases the element when the focused control is a password field', async () => {
    const bridge = fakeBridge({
      readFocusedElement: vi.fn(async () => element({ subrole: 'AXSecureTextField' }))
    })
    const result = await captureFocusedField({ bridge })
    expect(result).toMatchObject({ status: 'secure-field', app: APP })
    expect(bridge.releaseElement).toHaveBeenCalledWith('ax-1')
  })

  it('returns a live handle carrying the app and the classified field', async () => {
    const captured = await captureFocusedField({ bridge: fakeBridge() })
    if (captured.status !== 'field') throw new Error('expected a field')
    expect(captured.app).toEqual(APP)
    expect(captured.field).toMatchObject({ kind: 'area', surface: 'readable', value: 'hello' })
    expect(captured.released).toBe(false)
  })

  it('targets an explicit pid instead of the frontmost application', async () => {
    const bridge = fakeBridge()
    await captureFocusedField({ bridge, pid: 7777 })
    expect(bridge.readFocusedElement).toHaveBeenCalledWith(
      7777,
      expect.any(Number),
      expect.any(Number)
    )
  })
})

describe('CapturedField lifetime', () => {
  it('release is idempotent and frees the native element', async () => {
    const bridge = fakeBridge()
    const captured = await captureFocusedField({ bridge })
    if (captured.status !== 'field') throw new Error('expected a field')
    captured.release()
    captured.release()
    expect(bridge.releaseElement).toHaveBeenCalledTimes(1)
    expect(captured.released).toBe(true)
  })

  it('refuses an insert after release instead of touching a freed handle', async () => {
    const captured = await captureFocusedField({ bridge: fakeBridge() })
    if (captured.status !== 'field') throw new Error('expected a field')
    captured.release()
    expect(await captured.insert('x')).toEqual({ delivered: false, reason: 'released' })
  })

  it('supports `using` via Symbol.dispose', async () => {
    const bridge = fakeBridge()
    {
      using captured = (await captureFocusedField({ bridge })) as Extract<
        Awaited<ReturnType<typeof captureFocusedField>>,
        { status: 'field' }
      >
      expect(captured.status).toBe('field')
    }
    expect(bridge.releaseElement).toHaveBeenCalledWith('ax-1')
  })
})

describe('CapturedField.reread', () => {
  it('returns null when the user switched applications', async () => {
    const bridge = fakeBridge()
    const captured = await captureFocusedField({ bridge })
    if (captured.status !== 'field') throw new Error('expected a field')
    vi.mocked(bridge.frontmostApp).mockReturnValue({ pid: 1, bundleId: 'other', name: 'Other' })
    expect(await captured.reread()).toBeNull()
  })

  it('returns null when focus moved to a different element', async () => {
    const bridge = fakeBridge()
    const captured = await captureFocusedField({ bridge })
    if (captured.status !== 'field') throw new Error('expected a field')
    vi.mocked(bridge.verifyElement).mockResolvedValue({
      role: 'AXTextField',
      subrole: '',
      title: 'Search',
      description: '',
      placeholder: '',
      identifier: 'other',
      sameElement: false,
      enabled: true
    })
    expect(await captured.reread()).toBeNull()
  })

  it('refreshes value and selection from the live element', async () => {
    const bridge = fakeBridge({
      readElementState: vi.fn(async () =>
        textState({ value: 'hello world', selectionStart: 6, selectionLength: 5 })
      )
    })
    const captured = await captureFocusedField({ bridge })
    if (captured.status !== 'field') throw new Error('expected a field')
    const fresh = await captured.reread()
    expect(fresh).toMatchObject({ value: 'hello world', selectionStart: 6, selectionEnd: 11 })
    expect(captured.field.value).toBe('hello world')
  })

  it('returns the capture-time shape for an opaque surface without reading', async () => {
    const bridge = fakeBridge({
      readFocusedElement: vi.fn(async () => element({ selectedTextSettable: false }))
    })
    const captured = await captureFocusedField({ bridge })
    if (captured.status !== 'field') throw new Error('expected a field')
    const fresh = await captured.reread()
    expect(fresh).toMatchObject({ surface: 'opaque' })
    expect(bridge.readElementState).not.toHaveBeenCalled()
  })
})

describe('caret bounds and target traits', () => {
  it('reports the caret rectangle for anchoring UI to the insertion point', async () => {
    const captured = await captureFocusedField({ bridge: fakeBridge() })
    if (captured.status !== 'field') throw new Error('expected a field')
    expect(await captured.caretBounds()).toEqual({ x: 100, y: 200, width: 0, height: 16 })
  })

  it('reports null bounds rather than throwing when the element will not say', async () => {
    const bridge = fakeBridge({
      caretBounds: vi.fn(async () => {
        throw new Error('unsupported')
      })
    })
    const captured = await captureFocusedField({ bridge })
    if (captured.status !== 'field') throw new Error('expected a field')
    expect(await captured.caretBounds()).toBeNull()
  })

  it('flags a terminal target so callers can gate multiline text and submit', async () => {
    const bridge = fakeBridge({
      frontmostApp: vi.fn(() => ({ pid: 4242, bundleId: 'com.apple.Terminal', name: 'Terminal' }))
    })
    const captured = await captureFocusedField({ bridge })
    if (captured.status !== 'field') throw new Error('expected a field')
    expect(captured.traits.terminal).toBe(true)
  })

  it('does not flag an ordinary application', async () => {
    const captured = await captureFocusedField({ bridge: fakeBridge() })
    if (captured.status !== 'field') throw new Error('expected a field')
    expect(captured.traits.terminal).toBe(false)
  })
})

describe('submit prefers the element action over a keystroke', () => {
  it('uses the confirm action when the element advertises one', async () => {
    const bridge = fakeBridge({
      confirmElement: vi.fn(async () => ({ ok: true, advertised: true }))
    })
    const captured = await captureFocusedField({ bridge })
    if (captured.status !== 'field') throw new Error('expected a field')
    expect(await captured.submit()).toEqual({ submitted: true })
    // No synthetic event at all — nothing for modifier state or focus to distort.
    expect(bridge.postReturn).not.toHaveBeenCalled()
  })

  it('falls back to the chord when no confirm action exists', async () => {
    const bridge = fakeBridge()
    const captured = await captureFocusedField({ bridge })
    if (captured.status !== 'field') throw new Error('expected a field')
    expect(await captured.submit()).toEqual({ submitted: true })
    expect(bridge.postReturn).toHaveBeenCalledWith(4242, 'none')
  })

  it('skips the confirm action for a modified chord it cannot express', async () => {
    const bridge = fakeBridge({
      confirmElement: vi.fn(async () => ({ ok: true, advertised: true }))
    })
    const captured = await captureFocusedField({ bridge })
    if (captured.status !== 'field') throw new Error('expected a field')
    await captured.submit('command')
    expect(bridge.confirmElement).not.toHaveBeenCalled()
    expect(bridge.postReturn).toHaveBeenCalledWith(4242, 'command')
  })

  it('refuses to post the chord while the user holds modifiers', async () => {
    const bridge = fakeBridge({ currentModifierFlags: vi.fn(() => 0x100000) })
    const captured = await captureFocusedField({ bridge })
    if (captured.status !== 'field') throw new Error('expected a field')
    expect(await captured.submit()).toEqual({ submitted: false, reason: 'modifiers-held' })
    expect(bridge.postReturn).not.toHaveBeenCalled()
  })
})

describe('readFocusedField', () => {
  it('answers with pure data and releases the element before returning', async () => {
    const bridge = fakeBridge()
    const capture = await readFocusedField({ bridge })
    expect(capture).toMatchObject({ status: 'field', app: APP, field: { value: 'hello' } })
    expect(bridge.releaseElement).toHaveBeenCalledWith('ax-1')
  })
})

describe('insertText', () => {
  it('captures, inserts, and releases in one call', async () => {
    const bridge = fakeBridge()
    const outcome = await insertText(' world', { bridge })
    expect(outcome).toEqual({ delivered: true, via: 'accessibility' })
    expect(bridge.releaseElement).toHaveBeenCalledWith('ax-1')
  })

  it('carries the capture verdict when nothing insertable is focused', async () => {
    const bridge = fakeBridge({
      readFocusedElement: vi.fn(async () => element({ subrole: 'AXSecureTextField' }))
    })
    const outcome = await insertText('x', { bridge })
    expect(outcome).toMatchObject({
      delivered: false,
      reason: 'not-insertable',
      capture: { status: 'secure-field' }
    })
  })
})
