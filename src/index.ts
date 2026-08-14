/**
 * macos-insertable — find the focused text field of any macOS application, learn whether text
 * can be inserted there, and insert it, verified.
 *
 * Three levels, least to most involved:
 *
 * - {@link checkAccess} — is this platform supported, is the Accessibility permission granted?
 * - {@link readFocusedField} — what is focused right now, and is it insertable? Pure data out.
 * - {@link captureFocusedField} — pin the focused field now, deliver text to it later, with the
 *   target re-proven before every write. {@link insertText} is the one-call convenience form.
 */

import { loadBridge } from './addon.js'
import { captureFocusedField } from './capture.js'

import type { Access, Capture, CaptureOptions, InsertOptions, InsertResult } from './types.js'

export type {
  NativeBridge,
  RawConfirmResult,
  RawElementIdentity,
  RawFocusedElement,
  RawPasteboardSnapshot,
  RawReplaceResult,
  RawTextState,
  RawVerifyResult,
  RawWriteResult,
  ScreenRect,
  SecureInputCulprit,
  SubmitModifier
} from './bridge.js'
export type { CaptureResult, StartDraftResult, SubmitResult } from './capture.js'
export { CapturedField, captureFocusedField, readFocusedField } from './capture.js'
export type { ClassifyOptions, ElementVerdict } from './classify.js'
export { buildIdentity, classify, hasTextCapability, LABEL_MAX_CHARS } from './classify.js'
export type { DraftUpdateResult, MinimalEdit } from './draft.js'
export { Draft, minimalEdit } from './draft.js'
export { didTextLand, readCarriesEvidence } from './insert.js'
export { waitForModifiersReleased } from './modifiers.js'
export type { InsertionContext } from './spacing.js'
export { fitSpacing } from './spacing.js'
export { traitsFor } from './traits.js'
export type {
  Access,
  AppIdentity,
  Capture,
  CaptureOptions,
  DeliveredVia,
  FieldInfo,
  FieldKind,
  InsertMode,
  InsertOptions,
  InsertRefusal,
  InsertResult,
  InsertStrategy,
  Spacing,
  Surface,
  TargetTraits
} from './types.js'

/** Permission and environment state, checked without touching any other process. */
export function checkAccess(options: Pick<CaptureOptions, 'bridge'> = {}): Access {
  const bridge = options.bridge ?? loadBridge()
  if (!bridge) {
    return { supported: false, trusted: false, secureInput: false, secureInputHolder: null }
  }
  const secureInput = bridge.isSecureInputEnabled()
  return {
    supported: true,
    trusted: bridge.isAccessibilityTrusted(),
    secureInput,
    // Only asked when it can answer: the lookup walks the IO registry, and a null answer while
    // secure input is off would be indistinguishable from "the OS would not say".
    secureInputHolder: secureInput ? bridge.secureInputCulprit() : null
  }
}

export type InsertTextOutcome =
  | InsertResult
  | { delivered: false; reason: 'not-insertable'; capture: Capture }

/**
 * The one-call form: capture the frontmost application's focused field, insert, release. When
 * nothing insertable is focused, the capture verdict rides along so the caller can explain
 * exactly why — a password field, a disabled control, a missing permission — instead of "no".
 */
export async function insertText(
  text: string,
  options: InsertOptions & CaptureOptions = {}
): Promise<InsertTextOutcome> {
  const captured = await captureFocusedField(options)
  if (captured.status !== 'field') {
    return { delivered: false, reason: 'not-insertable', capture: captured }
  }
  try {
    return await captured.insert(text, options)
  } finally {
    captured.release()
  }
}
