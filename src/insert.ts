/**
 * Delivery: writes text into a captured field, most precise rung first.
 *
 *   1. Accessibility write (`readable` surfaces), **verified by read-back** — a silent no-op that
 *      still reports success is the dominant failure mode of the Accessibility API, so an
 *      unverified write falls through rather than being reported as delivered.
 *   2. Clipboard paste — the only rung for an `opaque` surface, and the fallback whenever a
 *      precise write did not take. Works in canvas editors, terminals and toolkits with no
 *      usable accessibility text. The pasteboard is borrowed, never taken: snapshotted before,
 *      restored after, and left alone if the user copied something of their own meanwhile.
 *   3. Synthetic keystrokes — when the pasteboard could not be borrowed safely.
 *
 * Every refusal is a typed reason. The caller learns exactly which guard fired, because "it did
 * nothing" is the whole bug report otherwise.
 */

import type { AppIdentity, NativeBridge, RawTextState } from './bridge.js'
import { buildIdentity } from './classify.js'
import type { FieldInfo, InsertOptions, InsertResult } from './types.js'

/** Accessibility messaging timeout for a write plus its read-back. */
const WRITE_TIMEOUT_MS = 400

/** Value cap for verification read-backs — enough to compare, not enough to copy a document. */
const VERIFY_MAX_CHARS = 8000

/** How long to let an application propagate an accessibility write before re-reading it. Short:
 *  this runs before the paste fallback, so it is latency the caller waits through either way. */
const AX_VERIFY_SETTLE_MS = 35

/** Re-reads of an accessibility write before giving up on it and pasting instead. Applications
 *  update their accessibility value on two schedules: a native Cocoa control updates before the
 *  write returns, while a Chromium-backed one round-trips to its renderer first and still reads
 *  as the OLD text. Re-reading after a beat distinguishes "not yet" from "never". */
const AX_VERIFY_ATTEMPTS = 3

/** How long to let the target application process a paste before reading the field back. */
const PASTE_SETTLE_MS = 90

/** Retries of the settle wait when the field has not visibly changed yet. */
const PASTE_VERIFY_ATTEMPTS = 3

/**
 * How long to hold the pasteboard for a target whose field cannot be read back, where elapsed
 * time is the only evidence available that the paste was served. Longer than the verified path
 * deliberately: restoring while the target is still reading makes it paste the PREVIOUS
 * clipboard — a wrong result that looks like a working feature — while waiting too long only
 * leaves the text on the pasteboard a moment more.
 */
const UNVERIFIABLE_PASTE_SETTLE_MS = 300

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Serializes the pasteboard borrow across concurrent insertions. The pasteboard is one
 * system-wide resource and a borrow spans several awaits; overlapping borrows let the second
 * insertion snapshot the FIRST one's text and later "restore" that as the user's clipboard.
 */
let pasteboardTurn: Promise<unknown> = Promise.resolve()

function withPasteboardTurn<T>(run: () => Promise<T>): Promise<T> {
  const next = pasteboardTurn.then(run, run)
  // The chain must survive a rejected insertion, or every later turn inherits the rejection.
  pasteboardTurn = next.catch(() => undefined)
  return next
}

export async function insertInto(
  bridge: NativeBridge,
  token: string,
  app: AppIdentity,
  field: FieldInfo,
  text: string,
  options: InsertOptions
): Promise<InsertResult> {
  const mode = options.mode ?? 'caret'
  const strategy = options.strategy ?? 'auto'

  if (!text) return { delivered: false, reason: 'empty-text' }
  if (!bridge.isAccessibilityTrusted()) return { delivered: false, reason: 'no-permission' }

  // Secure input suppresses synthetic events system-wide and means a password field is up.
  if (bridge.isSecureInputEnabled()) return { delivered: false, reason: 'secure-input' }

  if (field.readOnly) return { delivered: false, reason: 'read-only' }

  if (field.surface === 'readable') {
    const hasSelection =
      field.selectionStart !== null &&
      field.selectionEnd !== null &&
      field.selectionStart !== field.selectionEnd
    if (mode === 'caret' && hasSelection) {
      return { delivered: false, reason: 'selection-in-the-way' }
    }
    if (mode === 'selection' && !hasSelection) {
      return { delivered: false, reason: 'no-selection' }
    }
  }

  // Replacing a document that cannot be read back afterwards is destruction, not an edit. That
  // covers an opaque surface on any rung, and every rung except the verified accessibility
  // write on a readable one.
  if (mode === 'all' && (field.surface === 'opaque' || strategy !== 'auto')) {
    return { delivered: false, reason: 'unreadable-replace-all' }
  }

  const front = bridge.frontmostApp()
  if (!front || front.pid !== app.pid || (app.bundleId && front.bundleId !== app.bundleId)) {
    return { delivered: false, reason: 'app-changed' }
  }

  const verified = await bridge.verifyElement(token, app.pid, WRITE_TIMEOUT_MS).catch(() => null)
  if (!verified) return { delivered: false, reason: 'element-gone' }
  if (!verified.sameElement || buildIdentity(verified) !== field.identity) {
    return { delivered: false, reason: 'element-changed' }
  }
  if (!verified.enabled) return { delivered: false, reason: 'element-disabled' }

  if (strategy === 'auto' && field.surface === 'readable') {
    const written = await accessibilityWrite(bridge, token, text, mode)
    if (written) return { delivered: true, via: 'accessibility' }
    if (mode === 'all') {
      // The whole-field write did not take; an inexact fallback could destroy the document.
      return { delivered: false, reason: 'unreadable-replace-all' }
    }
  }

  if (strategy === 'keystrokes') {
    return typedDelivery(bridge, app, field, text, mode)
  }
  return withPasteboardTurn(() => clipboardDelivery(bridge, token, app, field, text, mode))
}

/**
 * Rung 1: set the text attribute and prove the write landed by reading the element back — first
 * in the same native trip, then on a short settle loop for applications that mirror their text
 * asynchronously.
 */
async function accessibilityWrite(
  bridge: NativeBridge,
  token: string,
  text: string,
  mode: 'caret' | 'selection' | 'all'
): Promise<boolean> {
  const before = await bridge
    .readElementState(token, WRITE_TIMEOUT_MS, VERIFY_MAX_CHARS)
    .catch(() => null)
  const write =
    mode === 'all'
      ? await bridge.setValue(token, text, WRITE_TIMEOUT_MS, VERIFY_MAX_CHARS).catch(() => null)
      : await bridge
          .setSelectedText(token, text, WRITE_TIMEOUT_MS, VERIFY_MAX_CHARS)
          .catch(() => null)
  if (!write?.ok) return false

  if (didTextLand(before, write.after, text, mode)) return true

  for (let attempt = 0; attempt < AX_VERIFY_ATTEMPTS; attempt += 1) {
    await wait(AX_VERIFY_SETTLE_MS)
    const after = await bridge
      .readElementState(token, WRITE_TIMEOUT_MS, VERIFY_MAX_CHARS)
      .catch(() => null)
    if (didTextLand(before, after, text, mode)) return true
  }
  return false
}

/**
 * Rung 2, falling to rung 3 when the pasteboard cannot be borrowed. On a failed paste the text is
 * deliberately LEFT on the pasteboard: content the user can still paste by hand beats content
 * that vanished.
 */
async function clipboardDelivery(
  bridge: NativeBridge,
  token: string,
  app: AppIdentity,
  field: FieldInfo,
  text: string,
  mode: 'caret' | 'selection' | 'all'
): Promise<InsertResult> {
  const snapshot = snapshotPasteboard(bridge)
  if (!snapshot) {
    return typedDelivery(bridge, app, field, text, mode)
  }

  let restorable = true
  try {
    const opaqueReplacement = mode === 'selection' && field.surface === 'opaque'
    const before =
      !opaqueReplacement && field.surface === 'readable'
        ? await bridge.readElementState(token, WRITE_TIMEOUT_MS, VERIFY_MAX_CHARS).catch(() => null)
        : null

    // Prepare the pasteboard before the destructive prerequisite so Backspace and paste are
    // adjacent synchronous posts. An opaque surface has no useful state to await between them.
    const expectedChangeCount = bridge.pasteboardWriteText(text)
    if (opaqueReplacement) {
      // Canvas editors replace-on-keydown; deleting the live selection first is what makes the
      // paste a replacement rather than an insertion beside still-selected text.
      if (!bridge.postBackspace(app.pid)) {
        restorable = bridge.pasteboardChangeCount() === expectedChangeCount
        return { delivered: false, reason: 'paste-not-posted' }
      }
    }
    if (!bridge.postPaste(app.pid)) {
      restorable = false
      return { delivered: false, reason: 'paste-not-posted' }
    }

    const landed = await verifyPaste(bridge, token, field, before, text, mode)
    // A restore is only ours to make if nothing else claimed the pasteboard after our write.
    restorable = bridge.pasteboardChangeCount() === expectedChangeCount
    if (!landed) {
      restorable = false
      return { delivered: false, reason: 'paste-did-not-land' }
    }
    return { delivered: true, via: 'clipboard' }
  } finally {
    if (restorable) {
      bridge.pasteboardRestore(snapshot)
    } else {
      bridge.pasteboardDiscardSnapshot(snapshot)
    }
  }
}

/** Rung 3: no pasteboard involvement at all, at the cost of speed and a length ceiling. */
async function typedDelivery(
  bridge: NativeBridge,
  app: AppIdentity,
  field: FieldInfo,
  text: string,
  mode: 'caret' | 'selection' | 'all'
): Promise<InsertResult> {
  if (mode === 'selection' && field.surface === 'opaque') {
    // Replacing an opaque selection needs Backspace immediately adjacent to the payload, which
    // chunked asynchronous typing cannot guarantee.
    return { delivered: false, reason: 'type-failed' }
  }
  const typed = await bridge.typeUnicode(app.pid, text).catch(() => false)
  return typed
    ? { delivered: true, via: 'keystrokes' }
    : { delivered: false, reason: 'type-failed' }
}

function snapshotPasteboard(bridge: NativeBridge): string | null {
  try {
    const snapshot = bridge.pasteboardSnapshot()
    if (snapshot.partial) {
      // Restoring half a clipboard is worse than not borrowing it at all.
      bridge.pasteboardDiscardSnapshot(snapshot.token)
      return null
    }
    return snapshot.token
  } catch {
    return null
  }
}

/**
 * A paste settles asynchronously inside the target app, so the field is re-read a few times. An
 * opaque surface cannot be verified at all: a posted paste is trusted after a settle long enough
 * for the target to have read the pasteboard — identity and focus checks are what aimed it.
 *
 * On a readable surface, a FAILED verdict needs positive evidence — a read that could have shown
 * the change and showed none. An editor can classify as readable at capture yet never update the
 * value it exposes, and a paste can re-render the captured element into unreadability; such
 * read-backs say nothing about the paste and leave it trusted, exactly as an opaque surface is.
 */
async function verifyPaste(
  bridge: NativeBridge,
  token: string,
  field: FieldInfo,
  before: RawTextState | null,
  text: string,
  mode: 'caret' | 'selection' | 'all'
): Promise<boolean> {
  if (field.surface !== 'readable') {
    await wait(UNVERIFIABLE_PASTE_SETTLE_MS)
    return true
  }

  let informativeRead = false
  for (let attempt = 0; attempt < PASTE_VERIFY_ATTEMPTS; attempt += 1) {
    await wait(PASTE_SETTLE_MS)
    const after = await bridge
      .readElementState(token, WRITE_TIMEOUT_MS, VERIFY_MAX_CHARS)
      .catch(() => null)
    if (didTextLand(before, after, text, mode)) return true
    if (readCarriesEvidence(before, after)) informativeRead = true
  }
  return !informativeRead
}

/**
 * Whether a read-back can bear witness against a paste. A read shows the field's text only when
 * the element exposes a value and there is text on at least one side of the paste to expose — an
 * element reporting empty both before and after is indistinguishable from one that never mirrors
 * its document, so its reads prove nothing either way.
 */
export function readCarriesEvidence(
  before: RawTextState | null,
  after: RawTextState | null
): boolean {
  if (!after || !after.hasValue) return false
  if (after.value.length > 0) return true
  return before !== null && before.hasValue && before.value.length > 0
}

/**
 * Whether a write reached the field. A length delta rather than an equality test: applications
 * normalize what they accept — trimming, autocorrecting, reformatting a phone number — and a
 * strict comparison would call those successes failures.
 */
export function didTextLand(
  before: RawTextState | null,
  after: RawTextState | null,
  text: string,
  mode: 'caret' | 'selection' | 'all'
): boolean {
  if (!after) return false

  // Nothing to compare against: accept a plausible end state rather than fail a real write.
  if (!before) return after.value.includes(text) || after.value.length > 0

  if (mode === 'all') return after.value === text || after.value !== before.value

  const grew = after.value.length > before.value.length
  const replacedSelection =
    mode === 'selection' && (after.value !== before.value || before.selectedText === text)
  return grew || replacedSelection
}
