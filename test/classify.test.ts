import { describe, expect, it } from 'vitest'

import { buildIdentity, classify, hasTextCapability, LABEL_MAX_CHARS } from '../src/classify.js'
import { element } from './fake-bridge.js'

const OPTIONS = { maxValueChars: 4000 }

describe('classify', () => {
  describe('roles are sufficient evidence', () => {
    it.each([
      ['AXTextField', 'field'],
      ['AXTextArea', 'area'],
      ['AXComboBox', 'field'],
      ['AXSearchField', 'field']
    ] as const)('%s is a %s', (role, kind) => {
      const verdict = classify(element({ role }), OPTIONS)
      expect(verdict).toMatchObject({ status: 'field', field: { kind } })
    })

    it('recognises a text role even when the element advertises nothing else', () => {
      const verdict = classify(
        element({ role: 'AXTextField', attributeNames: ['AXRole'] }),
        OPTIONS
      )
      expect(verdict.status).toBe('field')
    })
  })

  describe('capability beats role names', () => {
    it('recognises a container carrying the text vocabulary as an editor', () => {
      // A web app's composer can focus an AXGroup that matches no text role yet carries the
      // full text vocabulary; a role allowlist rejects every one of them.
      const verdict = classify(
        element({
          role: 'AXGroup',
          attributeNames: ['AXRole', 'AXValue', 'AXSelectedTextRange']
        }),
        OPTIONS
      )
      expect(verdict).toMatchObject({ status: 'field', field: { kind: 'container' } })
    })

    it('rejects a selectable transcript — a caret attribute alone is not editability', () => {
      // Measured against a live Electron app: a chat TRANSCRIPT (and even buttons) carries
      // AXValue, AXSelectedTextRange and AXInsertionPointLineNumber, because Chromium exposes
      // selection for READING everywhere. What it never carries is the editable-ancestor
      // marker family or a settable value — and without those it must not be insertable.
      const verdict = classify(
        element({
          role: 'AXGroup',
          description: 'Chat messages',
          valueSettable: false,
          selectedTextSettable: false,
          attributeNames: [
            'AXRole',
            'AXValue',
            'AXSelectedText',
            'AXSelectedTextRange',
            'AXInsertionPointLineNumber'
          ]
        }),
        OPTIONS
      )
      expect(verdict).toMatchObject({ status: 'not-a-field', role: 'AXGroup' })
    })

    it('accepts an unsettable browser editor through the editable-ancestor markers', () => {
      // Chromium contenteditables expose nothing settable — their content belongs to the
      // renderer — but stamp AXEditableAncestor on exactly the editable nodes.
      const verdict = classify(
        element({
          role: 'AXGroup',
          valueSettable: false,
          selectedTextSettable: false,
          attributeNames: ['AXRole', 'AXValue', 'AXSelectedTextRange', 'AXEditableAncestor']
        }),
        OPTIONS
      )
      expect(verdict).toMatchObject({ status: 'field', field: { kind: 'container' } })
    })

    it('requires a caret: text without an insertion point is a label, not an editor', () => {
      const verdict = classify(
        element({ role: 'AXStaticText', attributeNames: ['AXRole', 'AXValue'] }),
        OPTIONS
      )
      expect(verdict).toMatchObject({ status: 'not-a-field', role: 'AXStaticText' })
    })

    it('requires text content: a caret alone does not make an editor', () => {
      const verdict = classify(
        element({ role: 'AXGroup', attributeNames: ['AXRole', 'AXSelectedTextRange'] }),
        OPTIONS
      )
      expect(verdict.status).toBe('not-a-field')
    })

    it('reports the role and subrole of a non-field so a miss explains itself', () => {
      const verdict = classify(
        element({ role: 'AXButton', subrole: 'AXCloseButton', attributeNames: ['AXRole'] }),
        OPTIONS
      )
      expect(verdict).toEqual({ status: 'not-a-field', role: 'AXButton', subrole: 'AXCloseButton' })
    })

    it('exposes the capability test for callers with their own raw elements', () => {
      expect(hasTextCapability(element())).toBe(true)
      expect(hasTextCapability(element({ attributeNames: ['AXRole'] }))).toBe(false)
    })
  })

  describe('secure and disabled fields', () => {
    it('refuses a password field as its own status', () => {
      const verdict = classify(element({ subrole: 'AXSecureTextField' }), OPTIONS)
      expect(verdict).toEqual({ status: 'secure-field' })
    })

    it('refuses a secure field even when it looks like a plain text field otherwise', () => {
      const verdict = classify(
        element({ role: 'AXTextField', subrole: 'AXSecureTextField' }),
        OPTIONS
      )
      expect(verdict.status).toBe('secure-field')
    })

    it('reports a disabled control as disabled, not as a field', () => {
      const verdict = classify(element({ enabled: false }), OPTIONS)
      expect(verdict).toEqual({ status: 'disabled', role: 'AXTextArea' })
    })
  })

  describe('surface', () => {
    it('is readable when the element exposes text and a settable selection', () => {
      const verdict = classify(element(), OPTIONS)
      expect(verdict).toMatchObject({ field: { surface: 'readable', value: 'hello' } })
    })

    it('is opaque without a readable value', () => {
      const verdict = classify(element({ hasValue: false }), OPTIONS)
      expect(verdict).toMatchObject({ field: { surface: 'opaque' } })
    })

    it('is opaque without a settable selection', () => {
      const verdict = classify(element({ selectedTextSettable: false }), OPTIONS)
      expect(verdict).toMatchObject({ field: { surface: 'opaque' } })
    })

    it('blanks a value that is exactly the declared placeholder — decoration, not content', () => {
      const verdict = classify(
        element({ value: 'Ask anything…', placeholder: 'Ask anything…', selectionStart: 0 }),
        OPTIONS
      )
      expect(verdict).toMatchObject({
        field: { surface: 'readable', value: '', selectionStart: null }
      })
    })

    it('keeps a real value that merely matches no placeholder', () => {
      const verdict = classify(element({ value: 'Ask anything…', placeholder: '' }), OPTIONS)
      expect(verdict).toMatchObject({ field: { value: 'Ask anything…' } })
    })

    it('withholds an opaque element’s text — scratch is not the document', () => {
      const verdict = classify(
        element({ hasValue: false, value: 'ime scratch', selectedText: 'scr', selectionStart: 1 }),
        OPTIONS
      )
      expect(verdict).toMatchObject({
        field: { value: '', selectedText: '', selectionStart: null, selectionEnd: null }
      })
    })
  })

  describe('decoy geometry forces the opaque surface', () => {
    it('treats a tiny hidden input as opaque even when it looks readable', () => {
      // The Google Docs case, measured live: the focused element carries a small value and a
      // settable selection — everything `readable` asks for — but it is an IME decoy in a
      // degenerate box. Verifying against it convicts pastes that visibly landed.
      const verdict = classify(element({ frame: { x: 0, y: 0, width: 1, height: 1 } }), OPTIONS)
      expect(verdict).toMatchObject({ field: { surface: 'opaque', value: '' } })
    })

    it('treats an element parked off every display as opaque', () => {
      const verdict = classify(
        element({ frame: { x: -9999, y: -9999, width: 300, height: 40 }, frameOnScreen: false }),
        OPTIONS
      )
      expect(verdict).toMatchObject({ field: { surface: 'opaque' } })
    })

    it('does NOT call a zero-width but full-height editor a decoy', () => {
      // A rich-text root inside a flex row can measure zero wide while standing full height;
      // a single degenerate dimension proves nothing.
      const verdict = classify(
        element({ frame: { x: 300, y: 200, width: 0, height: 480 } }),
        OPTIONS
      )
      expect(verdict).toMatchObject({ field: { surface: 'readable' } })
    })

    it('trusts an element that reports no frame at all', () => {
      const verdict = classify(element({ frame: null }), OPTIONS)
      expect(verdict).toMatchObject({ field: { surface: 'readable' } })
    })
  })

  describe('read-only is a narrow signal', () => {
    it('marks a role-matched control with nothing settable as read-only', () => {
      const verdict = classify(
        element({ valueSettable: false, selectedTextSettable: false }),
        OPTIONS
      )
      expect(verdict).toMatchObject({ field: { readOnly: true } })
    })

    it('does NOT mark an unsettable container read-only — unsettable is not read-only', () => {
      // Browser-hosted editors expose nothing settable because their content belongs to the
      // renderer, yet they take typing and pasting fine. (The editable-ancestor marker is what
      // admits them as editors at all.)
      const verdict = classify(
        element({
          role: 'AXGroup',
          valueSettable: false,
          selectedTextSettable: false,
          attributeNames: ['AXRole', 'AXValue', 'AXSelectedTextRange', 'AXEditableAncestor']
        }),
        OPTIONS
      )
      expect(verdict).toMatchObject({ field: { readOnly: false } })
    })
  })

  describe('label', () => {
    it('prefers the title, then placeholder, then description', () => {
      expect(classify(element(), OPTIONS)).toMatchObject({ field: { label: 'Message' } })
      expect(classify(element({ title: '', placeholder: 'Type here' }), OPTIONS)).toMatchObject({
        field: { label: 'Type here' }
      })
      expect(classify(element({ title: '', description: 'Compose box' }), OPTIONS)).toMatchObject({
        field: { label: 'Compose box' }
      })
    })

    it('collapses whitespace and caps the length — applications control this text', () => {
      const verdict = classify(element({ title: `  a\n\n${'b'.repeat(300)}  ` }), OPTIONS)
      if (verdict.status !== 'field') throw new Error('expected a field')
      expect(verdict.field.label.startsWith('a b')).toBe(true)
      expect(verdict.field.label.length).toBeLessThanOrEqual(LABEL_MAX_CHARS)
    })
  })

  describe('purpose and shape', () => {
    it.each([
      ['AXSearchField', 'search'],
      ['AXURIField', 'url'],
      ['AXEmailField', 'email']
    ] as const)('reads %s as purpose %s', (subrole, purpose) => {
      const verdict = classify(element({ role: 'AXTextField', subrole }), OPTIONS)
      expect(verdict).toMatchObject({ field: { purposeHint: purpose } })
    })

    it('treats a text area as multiline and a text field as single-line', () => {
      expect(classify(element(), OPTIONS)).toMatchObject({ field: { multiline: true } })
      expect(classify(element({ role: 'AXTextField' }), OPTIONS)).toMatchObject({
        field: { multiline: false }
      })
    })

    it('treats a single-line field holding a newline as multiline after all', () => {
      const verdict = classify(element({ role: 'AXTextField', value: 'a\nb' }), OPTIONS)
      expect(verdict).toMatchObject({ field: { multiline: true } })
    })
  })

  describe('captured text', () => {
    it('caps the value at maxValueChars', () => {
      const verdict = classify(element({ value: 'x'.repeat(100) }), { maxValueChars: 10 })
      expect(verdict).toMatchObject({ field: { value: 'x'.repeat(10) } })
    })

    it('repairs unpaired surrogates before the text can reach a serializer', () => {
      const verdict = classify(element({ value: 'ok\uD800' }), OPTIONS)
      if (verdict.status !== 'field') throw new Error('expected a field')
      expect(() => JSON.stringify(verdict.field.value)).not.toThrow()
      expect(verdict.field.value).toBe('ok�')
    })

    it('derives the selection end from start plus length', () => {
      const verdict = classify(element({ selectionStart: 2, selectionLength: 3 }), OPTIONS)
      expect(verdict).toMatchObject({ field: { selectionStart: 2, selectionEnd: 5 } })
    })
  })

  describe('identity', () => {
    it('fingerprints the attributes delivery re-checks', () => {
      expect(buildIdentity(element())).toBe('AXTextArea||compose|Message|')
    })
  })
})
