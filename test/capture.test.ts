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
    expect(checkAccess({ bridge })).toEqual({ supported: true, trusted: true, secureInput: true })
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
