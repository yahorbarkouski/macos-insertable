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
  setValue(
    token: string,
    text: string,
    timeoutMs: number,
    valueMaxChars: number
  ): Promise<RawWriteResult>
  postPaste(expectedPid: number): boolean
  postBackspace(expectedPid: number): boolean
  typeUnicode(expectedPid: number, text: string): Promise<boolean>
  pasteboardChangeCount(): number
  pasteboardSnapshot(): RawPasteboardSnapshot
  pasteboardRestore(token: string): boolean
  pasteboardDiscardSnapshot(token: string): void
  pasteboardWriteText(text: string): number
  releaseElement(token: string): void
}
