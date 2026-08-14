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

/**
 * Subroles that name a text editor even when the role does not. Catalyst apps focus their
 * search fields as role AXStaticText with subrole AXSearchField (measured: WhatsApp — live
 * value, working caret, nothing settable but the selection range); the subrole is where the
 * truth went.
 */
const TEXT_SUBROLES: Record<string, FieldKind> = {
  AXSearchField: 'field'
}

const TEXT_CONTENT_ATTRIBUTES = ['AXValue', 'AXSelectedText']

/** A caret is what separates an editor from a label; labels expose text but never an insertion
 *  point. Necessary but NOT sufficient — see {@link EDITABLE_MARKER_ATTRIBUTES}. */
const CARET_ATTRIBUTES = ['AXInsertionPointLineNumber', 'AXSelectedTextRange']

/**
 * Editability evidence for a role-less container, because a caret attribute is not evidence.
 *
 * The caret vocabulary is everywhere: AppKit's modern accessibility bridge synthesizes
 * AXInsertionPointLineNumber and AXSelectedTextRange onto every element of any app adopting it —
 * a Finder button carries them, and so does a chat transcript in Electron, where selection
 * exists for READING. It is not Chromium handing them out; Chromium's own list adds them only
 * for text fields.
 *
 * Chromium DOES stamp these markers, from its shared platform-node layer, on every node with
 * the editable state — whole contenteditable subtrees, focus-independent, since roughly M120.
 * Older Chromium exposes none of them, which is why settability remains an accepted alternative.
 *
 * WebKit is the mirror image: it lists these markers on nearly every object (only web areas
 * remove them), so there they prove nothing — and it is the caret clause that discriminates,
 * since WebKit grants caret attributes only to real text controls. Safari's contenteditables
 * arrive as AXTextArea and are caught by role before this rule is consulted at all. The
 * conjunction survives both engines for opposite reasons.
 */
const EDITABLE_MARKER_ATTRIBUTES = ['AXEditableAncestor', 'AXHighestEditableAncestor']

const SECURE_SUBROLES = new Set(['AXSecureTextField'])

/** The platform's own statement of what the field expects. */
const PURPOSE_SUBROLES: Record<string, string> = {
  AXSearchField: 'search',
  AXURIField: 'url',
  AXEmailField: 'email'
}

const MULTILINE_ROLES = new Set(['AXTextArea'])

/**
 * Whether the element behaves like somewhere text goes, judged by what it advertises rather
 * than what it is called: it must carry text content, an insertion point, AND evidence that it
 * is actually editable — a settable value/selection (AppKit-style editors), or Chromium's
 * editable-ancestor markers (browser-hosted editors, which expose nothing settable because
 * their content belongs to the renderer).
 *
 * The third clause is what keeps selectable-but-read-only web text out: a chat transcript
 * carries the full text-and-caret vocabulary because its text can be selected FOR READING, and
 * without an editability check it classifies as a paste-only editor — an insertable verdict
 * for a surface no keystroke can ever change.
 */
export function hasTextCapability(element: RawFocusedElement): boolean {
  const attributes = new Set(element.attributeNames)
  const carriesText = TEXT_CONTENT_ATTRIBUTES.some((name) => attributes.has(name))
  const hasCaret = CARET_ATTRIBUTES.some((name) => attributes.has(name))
  const editable =
    element.valueSettable ||
    element.selectedTextSettable ||
    EDITABLE_MARKER_ATTRIBUTES.some((name) => attributes.has(name))
  return carriesText && hasCaret && editable
}

function fieldKindFor(element: RawFocusedElement): FieldKind | null {
  const byRole = TEXT_ROLES[element.role]
  if (byRole) return byRole
  const bySubrole = TEXT_SUBROLES[element.subrole]
  if (bySubrole) return bySubrole
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
 * Whether the element looks like a canvas editor's IME decoy rather than the surface being
 * edited. Google Docs is the canonical case: its focused element carries a small value AND a
 * settable selection — everything `readable` asks for — but it is a hidden input parked in a
 * degenerate box, its "value" is IME scratch, and verifying writes against it convicts pastes
 * that visibly landed in the document.
 *
 * Deliberately narrow, judged on geometry alone (no site lists): a decoy is tiny in BOTH
 * dimensions or parked entirely off every display. A single small dimension proves nothing —
 * real editors routinely report degenerate boxes (a rich-text root inside a flex row can
 * measure zero wide while standing full height), and calling those decoys would hide a
 * readable document behind the unverifiable path.
 */
function isDecoyLike(element: RawFocusedElement): boolean {
  if (!element.frameOnScreen) return true
  const frame = element.frame
  if (!frame) return false
  return frame.width <= 2 && frame.height <= 2
}

/**
 * Precise edits need both halves: readable text to verify a write against, and a settable
 * selection to write through. Missing either — or a decoy geometry that makes the "readable"
 * text a lie — means aimed trusted input, as for a canvas editor.
 */
function surfaceFor(element: RawFocusedElement): 'readable' | 'opaque' {
  if (isDecoyLike(element)) return 'opaque'
  return element.hasValue && element.selectedTextSettable ? 'readable' : 'opaque'
}

/**
 * Unsettable is NOT read-only. A container that reports nothing settable still takes typing and
 * pasting — some web editors keep their content in the renderer and expose it that way, and old
 * Chromium exposed no settability at all (current builds do report editable web fields as
 * settable, so this rule protects fewer surfaces than it once did, not none). Settability is a
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

  // Rich composers render their placeholder as literal text in the accessibility value while
  // empty. That text is decoration, not content — reporting it as the field's value hands
  // callers a phantom document.
  const phantomValue = element.placeholder !== '' && element.value === element.placeholder

  // An opaque element's text is not the document; presenting IME scratch as content is how a
  // caller ends up "verifying" against a decoy.
  const value = readable && !phantomValue ? wellFormed(element.value).slice(0, maxValueChars) : ''
  const selectedText = readable && !phantomValue ? wellFormed(element.selectedText) : ''

  const hasSelection =
    readable && !phantomValue && element.selectionStart !== null && element.selectionLength !== null
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
