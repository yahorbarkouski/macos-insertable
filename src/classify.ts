/**
 * Decides what a raw focused element IS. Pure by design: the native bridge reads attributes,
 * this decides what they mean — so the decision runs identically under test on any platform.
 *
 * The central rule: text capability is *detected from what the element advertises*, never guessed
 * from a list of known role names. Rich editors routinely focus a container carrying the full
 * text vocabulary while matching no text role — a web app's composer can be an AXGroup. A role
 * is sufficient evidence, but never necessary.
 */

import type { RawElementIdentity, RawFocusedElement } from './bridge.js'
import { wellFormed } from './sanitize.js'
import type { FieldInfo, FieldKind } from './types.js'

/** One short descriptor is enough to name a field; applications control this text, so it is
 *  capped rather than trusted. */
export const LABEL_MAX_CHARS = 120

/** Roles that name a text editor. Sufficient, never necessary — see {@link hasTextCapability}. */
const TEXT_ROLES: Record<string, FieldKind> = {
  AXTextField: 'field',
  AXTextArea: 'area',
  AXComboBox: 'field',
  AXSearchField: 'field'
}

const TEXT_CONTENT_ATTRIBUTES = ['AXValue', 'AXSelectedText']

/** A caret is what separates an editor from a label; labels expose text but never an insertion
 *  point. */
const CARET_ATTRIBUTES = ['AXInsertionPointLineNumber', 'AXSelectedTextRange']

const SECURE_SUBROLES = new Set(['AXSecureTextField'])

/** The platform's own statement of what the field expects. */
const PURPOSE_SUBROLES: Record<string, string> = {
  AXSearchField: 'search',
  AXURIField: 'url',
  AXEmailField: 'email'
}

const MULTILINE_ROLES = new Set(['AXTextArea'])

/**
 * Whether the element behaves like somewhere text goes, judged by what it advertises rather than
 * what it is called: it must carry text content AND an insertion point.
 */
export function hasTextCapability(element: RawFocusedElement): boolean {
  const attributes = new Set(element.attributeNames)
  const carriesText = TEXT_CONTENT_ATTRIBUTES.some((name) => attributes.has(name))
  const hasCaret = CARET_ATTRIBUTES.some((name) => attributes.has(name))
  return carriesText && hasCaret
}

function fieldKindFor(element: RawFocusedElement): FieldKind | null {
  const byRole = TEXT_ROLES[element.role]
  if (byRole) return byRole
  if (!hasTextCapability(element)) return null
  // Single-line controls are exactly the ones that do use the standard roles.
  return 'container'
}

/** First non-empty of the names a person would read, whitespace-collapsed and capped. */
function labelFor(element: RawElementIdentity): string {
  for (const candidate of [element.title, element.placeholder, element.description]) {
    const text = candidate.trim().replace(/\s+/g, ' ')
    if (text) return text.slice(0, LABEL_MAX_CHARS)
  }
  return ''
}

/**
 * Precise edits need both halves: readable text to verify a write against, and a settable
 * selection to write through. Missing either means aimed trusted input, as for a canvas editor.
 */
function surfaceFor(element: RawFocusedElement): 'readable' | 'opaque' {
  return element.hasValue && element.selectedTextSettable ? 'readable' : 'opaque'
}

/**
 * Unsettable is NOT read-only: browser-hosted editors expose nothing settable because their
 * content belongs to the renderer, yet they take typing and pasting fine. Settability is a
 * trustworthy read-only signal only for native controls matched by role; the caret requirement
 * already excludes text that cannot be edited at all.
 */
function isReadOnly(element: RawFocusedElement): boolean {
  if (!element.enabled) return true
  const matchedByRole = TEXT_ROLES[element.role] !== undefined
  if (!matchedByRole) return false
  return !element.valueSettable && !element.selectedTextSettable
}

export interface ClassifyOptions {
  /** Value length cap applied to the captured text. */
  maxValueChars: number
}

/** The element-level half of a `Capture`: everything except which application it came from. */
export type ElementVerdict =
  | { status: 'field'; field: FieldInfo }
  | { status: 'secure-field' }
  | { status: 'disabled'; role: string }
  | { status: 'not-a-field'; role: string; subrole: string }

/**
 * Decides the verdict for one raw element. Secure and disabled elements come back as their own
 * statuses — an insertion will never be attempted against either, and a secure field's text has
 * already been withheld by the native layer.
 */
export function classify(
  element: RawFocusedElement,
  { maxValueChars }: ClassifyOptions
): ElementVerdict {
  if (SECURE_SUBROLES.has(element.subrole)) {
    return { status: 'secure-field' }
  }

  const kind = fieldKindFor(element)
  if (kind === null) {
    return { status: 'not-a-field', role: element.role, subrole: element.subrole }
  }

  if (!element.enabled) {
    return { status: 'disabled', role: element.role }
  }

  return { status: 'field', field: buildFieldInfo(element, kind, maxValueChars) }
}

function buildFieldInfo(
  element: RawFocusedElement,
  kind: FieldKind,
  maxValueChars: number
): FieldInfo {
  const surface = surfaceFor(element)
  const readable = surface === 'readable'

  // An opaque element's text is not the document; presenting IME scratch as content is how a
  // caller ends up "verifying" against a decoy.
  const value = readable ? wellFormed(element.value).slice(0, maxValueChars) : ''
  const selectedText = readable ? wellFormed(element.selectedText) : ''

  const hasSelection =
    readable && element.selectionStart !== null && element.selectionLength !== null
  const selectionStart = hasSelection ? element.selectionStart : null
  const selectionEnd =
    hasSelection && element.selectionStart !== null && element.selectionLength !== null
      ? element.selectionStart + element.selectionLength
      : null

  return {
    kind,
    surface,
    label: wellFormed(labelFor(element)),
    purposeHint: PURPOSE_SUBROLES[element.subrole] ?? '',
    multiline: kind !== 'field' || MULTILINE_ROLES.has(element.role) || value.includes('\n'),
    value,
    selectionStart,
    selectionEnd,
    selectedText,
    readOnly: isReadOnly(element),
    identity: buildIdentity(element)
  }
}

/**
 * Re-checked before delivery to refuse a different element than the one captured. The bridge
 * separately proves the object is unchanged; this catches an application reusing one element.
 */
export function buildIdentity(element: RawElementIdentity): string {
  return [
    element.role,
    element.subrole,
    element.identifier,
    element.title,
    element.placeholder
  ].join('|')
}
