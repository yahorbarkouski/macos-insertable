/**
 * The seam between judgment and platform. Everything above this interface is pure TypeScript,
 * unit-testable against a fake on any operating system; everything below it is the compiled
 * addon. The vocabulary is deliberately platform-neutral so a Windows UI Automation backend can
 * satisfy the same interface unchanged.
 */

/** The application currently in front of the user. */
export interface AppIdentity {
  pid: number
  bundleId: string
  /** OS-provided display name. UNTRUSTED — an application may name itself anything. */
  name: string
}

/** Identity attributes, re-read before delivery to refuse writing into a different element. */
export interface RawElementIdentity {
  role: string
  subrole: string
  title: string
  description: string
  placeholder: string
  identifier: string
}

/** Mutable text state, read back after a write so the caller can verify it landed. */
export interface RawTextState {
  /** False when the element exposes no readable text — a canvas or model-backed editor. */
  hasValue: boolean
  value: string
  selectedText: string
  selectionStart: number | null
  selectionLength: number | null
  /** -1 when the element does not report a character count. */
  numberOfCharacters: number
}

export interface RawFocusedElement extends RawElementIdentity, RawTextState {
  /** Opaque handle to the live element, valid until `releaseElement`. */
  token: string
  /** Every attribute the element advertises. Text capability is detected from these rather than
   *  guessed from the role, so editors that focus a container are still recognised. */
  attributeNames: string[]
  valueSettable: boolean
  selectedTextSettable: boolean
  enabled: boolean
  /** On-screen bounds in CG global coordinates, or null when the element reports none. */
  frame: { x: number; y: number; width: number; height: number } | null
  /** Whether `frame` intersects any active display; true when there is no frame to judge. */
  frameOnScreen: boolean
}

export interface RawVerifyResult extends RawElementIdentity {
  /** True when the app's focused element is the very same object that was captured. */
  sameElement: boolean
  enabled: boolean
}

export interface RawWriteResult {
  ok: boolean
  error: string | null
  after: RawTextState | null
}

export interface RawSelectionResult {
  ok: boolean
  error: string | null
  /** The selection read back in the same trip; null when the element would not report one. */
  selectionStart: number | null
  selectionLength: number | null
}

export interface RawCasResult {
  ok: boolean
  /** 'element-gone' | 'element-changed' | 'region-mismatch' | 'select-failed' |
   *  'write-failed' | 'verify-failed', or null on success. */
  reason: string | null
  /** Whether the caret was parked — false also when the user had moved it, which skips the
   *  park on purpose. */
  parked: boolean
  /** Which swap tactic landed: 'selected-text' (O(edit)) or 'value-splice' (whole-value
   *  rewrite, the tactic Chromium answers to). Null on failure. The caller passes this back
   *  as preferSplice so discovery is paid once per element, not per update. */
  via: string | null
}

/** Chat-style applications disagree on the send chord; the modifier is the caller's choice. */
export type SubmitModifier = 'none' | 'shift' | 'command'

/** The process holding the Secure Event Input grab. Best effort: macOS documents no reliable
 *  API, and the pid can be wrong or absent when the grab was taken from the background. */
export interface SecureInputCulprit {
  pid: number
  name: string
  bundleId: string
}

/** A rectangle in global screen coordinates. */
export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

export interface RawReplaceResult {
  ok: boolean
  /** 'element-gone' | 'encoding-failed' | 'unsupported', or null on success. */
  error: string | null
}

export interface RawConfirmResult {
  ok: boolean
  /** False when the element exposes no confirm action at all — the caller falls back to a chord. */
  advertised: boolean
}

export interface RawPasteboardSnapshot {
  token: string
  changeCount: number
  itemCount: number
  /** True when the pasteboard exceeded the copy budget and was not fully captured. */
  partial: boolean
}

export interface NativeBridge {
  isAccessibilityTrusted(): boolean
  isSecureInputEnabled(): boolean
  /** Names the app holding the secure-input grab, or null when nothing holds it (or the OS
   *  will not say). */
  secureInputCulprit(): SecureInputCulprit | null
  /** The modifier flags the user is physically holding, as a CGEventFlags mask. */
  currentModifierFlags(): number
  frontmostApp(): AppIdentity | null
  readFocusedElement(
    pid: number,
    timeoutMs: number,
    valueMaxChars: number
  ): Promise<RawFocusedElement | null>
  readElementState(
    token: string,
    timeoutMs: number,
    valueMaxChars: number
  ): Promise<RawTextState | null>
  /** Asks an application to expose a tree it only builds for assistive technology. Diagnostic
   *  only — measured unable to surface fields in the apps that hide them. */
  primeAccessibility(pid: number, timeoutMs: number): Promise<boolean>
  verifyElement(token: string, pid: number, timeoutMs: number): Promise<RawVerifyResult | null>
  setSelectedText(
    token: string,
    text: string,
    timeoutMs: number,
    valueMaxChars: number
  ): Promise<RawWriteResult>
  /** Aims a precise range edit: select [start, start+length), then replace the selection. */
  setSelectedTextRange(
    token: string,
    start: number,
    length: number,
    timeoutMs: number
  ): Promise<RawSelectionResult>
  /**
   * Compare-and-swap on a text region, fused into one native trip: prove the element is still
   * its app's focused element, compare [regionStart, regionStart+expected.length) against
   * `expected`, replace the [editStart, editEnd) span of it (offsets relative to the region)
   * with `replacement`, verify the result over the region only (O(edit), never O(document)),
   * and park the caret at `parkAt` unless the live caret is not at `expectedCaret` — a caret
   * the user moved is not ours to move back. Negative parkAt skips parking; negative
   * expectedCaret parks unconditionally. All offsets are UTF-16 units.
   */
  casRangeEdit(
    token: string,
    regionStart: number,
    expected: string,
    editStart: number,
    editEnd: number,
    replacement: string,
    parkAt: number,
    expectedCaret: number,
    preferSplice: number,
    timeoutMs: number
  ): Promise<RawCasResult>
  setValue(
    token: string,
    text: string,
    timeoutMs: number,
    valueMaxChars: number
  ): Promise<RawWriteResult>
  /** The caret's on-screen rectangle (zero width), for anchoring UI to the insertion point. */
  caretBounds(token: string, timeoutMs: number): Promise<ScreenRect | null>
  /**
   * One-call range replace via `AXReplaceRangeWithText`. On AppKit it routes through the
   * element's input context (native undo coalescing, delegate notifications); on WebKit it is a
   * real editing command; Chromium advertises but does not implement it, so callers treat
   * `ok: false` as "take the next rung" rather than an error.
   */
  replaceRange(
    token: string,
    start: number,
    length: number,
    text: string,
    timeoutMs: number
  ): Promise<RawReplaceResult>
  /** Performs the element's confirm action, when it advertises one — a keystroke-free submit. */
  confirmElement(token: string, timeoutMs: number): Promise<RawConfirmResult>
  postPaste(expectedPid: number): boolean
  postReturn(expectedPid: number, modifier: SubmitModifier): boolean
  postBackspace(expectedPid: number): boolean
  typeUnicode(expectedPid: number, text: string): Promise<boolean>
  pasteboardChangeCount(): number
  pasteboardSnapshot(): RawPasteboardSnapshot
  pasteboardRestore(token: string): boolean
  pasteboardDiscardSnapshot(token: string): void
  pasteboardWriteText(text: string): number
  releaseElement(token: string): void
}
