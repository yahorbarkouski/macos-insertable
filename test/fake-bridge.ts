/**
 * A complete in-memory NativeBridge. Every decision in this library is pure TypeScript above
 * this interface, so the entire behavior — classification, preflight, the delivery ladder,
 * pasteboard borrowing — is testable here on any operating system.
 */

import { vi } from 'vitest'

import type { AppIdentity, NativeBridge, RawFocusedElement, RawTextState } from '../src/bridge.js'

export const APP: AppIdentity = { pid: 4242, bundleId: 'com.example.editor', name: 'Editor' }

/** Identity string buildIdentity() produces for the element below. */
export const IDENTITY = 'AXTextArea||compose|Message|'

export function element(overrides: Partial<RawFocusedElement> = {}): RawFocusedElement {
  return {
    token: 'ax-1',
    role: 'AXTextArea',
    subrole: '',
    title: 'Message',
    description: '',
    placeholder: '',
    identifier: 'compose',
    hasValue: true,
    value: 'hello',
    selectedText: '',
    selectionStart: 5,
    selectionLength: 0,
    numberOfCharacters: 5,
    valueSettable: true,
    selectedTextSettable: true,
    enabled: true,
    attributeNames: ['AXRole', 'AXValue', 'AXSelectedText', 'AXSelectedTextRange'],
    ...overrides
  }
}

export function textState(overrides: Partial<RawTextState> = {}): RawTextState {
  return {
    hasValue: true,
    value: 'hello',
    selectedText: '',
    selectionStart: 5,
    selectionLength: 0,
    numberOfCharacters: 5,
    ...overrides
  }
}

export function fakeBridge(overrides: Partial<NativeBridge> = {}): NativeBridge {
  return {
    isAccessibilityTrusted: vi.fn(() => true),
    isSecureInputEnabled: vi.fn(() => false),
    frontmostApp: vi.fn(() => APP),
    readFocusedElement: vi.fn(async () => element()),
    readElementState: vi.fn(async () => textState()),
    primeAccessibility: vi.fn(async () => false),
    verifyElement: vi.fn(async () => ({
      role: 'AXTextArea',
      subrole: '',
      title: 'Message',
      description: '',
      placeholder: '',
      identifier: 'compose',
      sameElement: true,
      enabled: true
    })),
    setSelectedText: vi.fn(async () => ({
      ok: true,
      error: null,
      after: textState({ value: 'hello world' })
    })),
    setValue: vi.fn(async () => ({
      ok: true,
      error: null,
      after: textState({ value: 'replaced' })
    })),
    postPaste: vi.fn(() => true),
    postBackspace: vi.fn(() => true),
    typeUnicode: vi.fn(async () => true),
    pasteboardChangeCount: vi.fn(() => 2),
    pasteboardSnapshot: vi.fn(() => ({
      token: 'pb-1',
      changeCount: 1,
      itemCount: 1,
      partial: false
    })),
    pasteboardRestore: vi.fn(() => true),
    pasteboardDiscardSnapshot: vi.fn(),
    pasteboardWriteText: vi.fn(() => 2),
    releaseElement: vi.fn(),
    ...overrides
  }
}
