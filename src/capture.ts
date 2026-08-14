/**
 * Capture: pin the focused element of an application NOW so text can be delivered to it LATER —
 * after a network round-trip, a transcription, a user pause — without trusting whatever happens
 * to hold focus by then. The captured element is re-verified (same live object, same identity)
 * before every write, and a mismatch refuses rather than misdirects.
 */

import { loadBridge } from './addon.js'
import type { AppIdentity, NativeBridge } from './bridge.js'
import { buildIdentity, classify } from './classify.js'
import { insertInto } from './insert.js'
import { wellFormed } from './sanitize.js'
import type { Capture, CaptureOptions, FieldInfo, InsertOptions, InsertResult } from './types.js'

/** Accessibility messaging timeout per call into the target application. */
export const DEFAULT_TIMEOUT_MS = 250

/** Cap on how much field text is copied out of the target application. */
export const DEFAULT_VALUE_MAX_CHARS = 16_000

/**
 * A live handle on the captured field. Holds a retained reference to the element inside the
 * target application until {@link release} — release it when done, or let `using` do it:
 *
 * ```ts
 * using captured = await captureFocusedField()
 * if (captured.status === 'field') await captured.insert('hello')
 * ```
 */
export class CapturedField {
  public readonly status = 'field' as const

  #bridge: NativeBridge
  #token: string
  #timeoutMs: number
  #released = false
  #field: FieldInfo

  public readonly app: AppIdentity

  constructor(
    bridge: NativeBridge,
    token: string,
    app: AppIdentity,
    field: FieldInfo,
    timeoutMs: number
  ) {
    this.#bridge = bridge
    this.#token = token
    this.app = app
    this.#field = field
    this.#timeoutMs = timeoutMs
  }

  /** The field as last read — at capture, or by the most recent successful {@link reread}. */
  public get field(): FieldInfo {
    return this.#field
  }

  public get released(): boolean {
    return this.#released
  }

  /**
   * Delivers text into the captured field. Every call re-proves the target first — application
   * still frontmost, element still focused, identity unchanged — so a stale handle refuses with
   * a reason instead of writing into the wrong place.
   */
  public async insert(text: string, options: InsertOptions = {}): Promise<InsertResult> {
    if (this.#released) return { delivered: false, reason: 'released' }
    return insertInto(this.#bridge, this.#token, this.app, this.#field, text, options)
  }

  /**
   * Re-reads the field's current text and selection, but only after proving the captured element
   * still holds focus. Returns null when the world moved on — the user switched applications,
   * focus left the element, or the element was replaced — in which case the handle should be
   * released and a fresh capture taken.
   */
  public async reread(): Promise<FieldInfo | null> {
    if (this.#released) return null
    const bridge = this.#bridge

    const front = bridge.frontmostApp()
    if (!front || front.pid !== this.app.pid || front.bundleId !== this.app.bundleId) return null

    const verified = await bridge
      .verifyElement(this.#token, this.app.pid, this.#timeoutMs)
      .catch(() => null)
    if (!verified?.sameElement || !verified.enabled) return null
    if (buildIdentity(verified) !== this.#field.identity) return null

    // An opaque surface has no text to re-read; the capture-time shape is all there is.
    if (this.#field.surface === 'opaque') return this.#field

    const state = await bridge
      .readElementState(this.#token, this.#timeoutMs, DEFAULT_VALUE_MAX_CHARS)
      .catch(() => null)
    if (!state?.hasValue) return null

    const value = wellFormed(state.value).slice(0, DEFAULT_VALUE_MAX_CHARS)
    const selectedText = wellFormed(state.selectedText).slice(0, DEFAULT_VALUE_MAX_CHARS)
    const hasSelection = state.selectionStart !== null && state.selectionLength !== null
    this.#field = {
      ...this.#field,
      value,
      selectedText,
      selectionStart: hasSelection ? state.selectionStart : null,
      selectionEnd:
        hasSelection && state.selectionStart !== null && state.selectionLength !== null
          ? state.selectionStart + state.selectionLength
          : null,
      multiline: this.#field.multiline || value.includes('\n')
    }
    return this.#field
  }

  /** Releases the retained element inside the target application. Safe to call twice. */
  public release(): void {
    if (this.#released) return
    this.#released = true
    this.#bridge.releaseElement(this.#token)
  }

  public [Symbol.dispose](): void {
    this.release()
  }
}

/** A capture that pins the element: the `field` arm is a live {@link CapturedField} handle. */
export type CaptureResult = CapturedField | Exclude<Capture, { status: 'field' }>

/**
 * Captures the focused field of an application (the frontmost one by default), holding a live
 * reference for later delivery. Release the returned handle when the `field` arm is taken.
 */
export async function captureFocusedField(options: CaptureOptions = {}): Promise<CaptureResult> {
  const bridge = options.bridge ?? loadBridge()
  if (!bridge) return { status: 'unsupported' }
  if (!bridge.isAccessibilityTrusted()) return { status: 'no-permission' }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const valueMaxChars = options.valueMaxChars ?? DEFAULT_VALUE_MAX_CHARS

  let app: AppIdentity | null = bridge.frontmostApp()
  if (options.pid !== undefined) {
    app = app?.pid === options.pid ? app : { pid: options.pid, bundleId: '', name: '' }
  }
  if (!app) return { status: 'no-element', app: null }

  const element = await bridge
    .readFocusedElement(app.pid, timeoutMs, valueMaxChars)
    .catch(() => null)
  if (!element) return { status: 'no-element', app }

  const verdict = classify(element, { maxValueChars: valueMaxChars })
  if (verdict.status !== 'field') {
    bridge.releaseElement(element.token)
    return { ...verdict, app }
  }

  return new CapturedField(bridge, element.token, app, verdict.field, timeoutMs)
}

/**
 * Answers "what is focused, and is it insertable?" without keeping anything alive — the
 * inspect-only form of {@link captureFocusedField}. Pure data out; nothing to release.
 */
export async function readFocusedField(options: CaptureOptions = {}): Promise<Capture> {
  const result = await captureFocusedField(options)
  if (result.status !== 'field') return result
  const capture: Capture = { status: 'field', app: result.app, field: result.field }
  result.release()
  return capture
}
