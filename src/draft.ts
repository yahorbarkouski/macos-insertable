/**
 * Draft: a region of a field this process owns and keeps reconciling to new text.
 *
 * One concept covers the whole revision family transcription and AI apps need: streaming
 * partials that appear while the user is still speaking, the corrected final transcript
 * replacing them, an LLM cleanup arriving a second later, "scratch that" (reconcile to ""),
 * and dictating over a selection. Each `update` is a DIFF-MINIMAL edit — only the changed span
 * is selected and replaced, so revising one word of a paragraph costs one tiny write, keeps
 * latency at AX-round-trip scale, and never repaints text that did not change.
 *
 * Drafts exist only on `readable` surfaces: precise range edits need a settable selection and
 * a value to verify against. Every update re-proves the world first (same app frontmost, same
 * live element, the draft region still holding exactly what we last wrote) and refuses with a
 * typed reason when the user got there first — their keystrokes outrank our transcript.
 */

import type { AppIdentity, NativeBridge } from './bridge.js'
import { buildIdentity } from './classify.js'
import { wellFormed } from './sanitize.js'

/** Accessibility messaging timeout for one aim-write-verify trip. */
const DRAFT_TIMEOUT_MS = 400

/** Read-back cap: enough to verify the draft region and its surroundings. */
const DRAFT_VERIFY_MAX_CHARS = 16_000

/** One settle retry for applications that mirror their text asynchronously. Kept to a single
 *  short beat — updates arrive several times a second while streaming, and a slow mirror is
 *  caught by the next update's precondition read anyway. */
const DRAFT_SETTLE_MS = 35

export interface MinimalEdit {
  /** UTF-16 offset into the old text where the change begins. */
  start: number
  /** UTF-16 offset into the old text where the change ends (exclusive). */
  end: number
  replacement: string
}

/**
 * The smallest single-span edit turning `before` into `after`, or null when they are equal.
 * Boundaries never split a surrogate pair — the offsets go straight into UTF-16 range APIs.
 */
export function minimalEdit(before: string, after: string): MinimalEdit | null {
  if (before === after) return null

  let prefix = 0
  const maxPrefix = Math.min(before.length, after.length)
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix += 1
  // Backing off a split pair: a boundary between a high and low surrogate would hand the range
  // API half a character.
  if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1))) prefix -= 1

  let suffix = 0
  const maxSuffix = Math.min(before.length, after.length) - prefix
  while (
    suffix < maxSuffix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) suffix -= 1

  return {
    start: prefix,
    end: before.length - suffix,
    replacement: after.slice(prefix, after.length - suffix)
  }
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff
}

export type DraftUpdateResult =
  | { delivered: true }
  | {
      delivered: false
      reason:
        | 'no-permission'
        | 'secure-input'
        | 'app-changed'
        | 'element-changed'
        | 'element-gone'
        | 'element-disabled'
        /** The field no longer holds what this draft last wrote — the user (or the app) edited
         *  the region. Their edit wins; take a fresh capture instead of fighting it. */
        | 'draft-drifted'
        /** The range could not be aimed or the replacement did not land. */
        | 'range-write-failed'
    }

export class Draft {
  #bridge: NativeBridge
  #token: string
  #app: AppIdentity
  #identity: string
  /** UTF-16 offset where the draft region begins in the field. */
  #anchor: number
  /** What this draft believes the field holds inside its region. */
  #text: string

  constructor(
    bridge: NativeBridge,
    token: string,
    app: AppIdentity,
    identity: string,
    anchor: number,
    initialText: string
  ) {
    this.#bridge = bridge
    this.#token = token
    this.#app = app
    this.#identity = identity
    this.#anchor = anchor
    this.#text = initialText
  }

  /** The text the draft currently owns. */
  public get text(): string {
    return this.#text
  }

  /** The draft's region in the field, as UTF-16 offsets. */
  public get range(): { start: number; end: number } {
    return { start: this.#anchor, end: this.#anchor + this.#text.length }
  }

  /**
   * Reconciles the draft region to `next` with one minimal range edit. Equal text is a free
   * no-op; empty text deletes the region ("scratch that"). The caret is parked at the end of
   * the draft afterwards, where the next word belongs.
   */
  public async update(next: string): Promise<DraftUpdateResult> {
    const bridge = this.#bridge
    const text = wellFormed(next)

    if (!bridge.isAccessibilityTrusted()) return { delivered: false, reason: 'no-permission' }
    if (bridge.isSecureInputEnabled()) return { delivered: false, reason: 'secure-input' }

    const front = bridge.frontmostApp()
    if (
      !front ||
      front.pid !== this.#app.pid ||
      (this.#app.bundleId && front.bundleId !== this.#app.bundleId)
    ) {
      return { delivered: false, reason: 'app-changed' }
    }

    const verified = await bridge
      .verifyElement(this.#token, this.#app.pid, DRAFT_TIMEOUT_MS)
      .catch(() => null)
    if (!verified) return { delivered: false, reason: 'element-gone' }
    if (!verified.sameElement || buildIdentity(verified) !== this.#identity) {
      return { delivered: false, reason: 'element-changed' }
    }
    if (!verified.enabled) return { delivered: false, reason: 'element-disabled' }

    // The precondition read: the region must hold exactly what we last wrote. Anything else
    // means the user or the application edited it, and a range write now would destroy their
    // work using stale coordinates.
    const state = await bridge
      .readElementState(this.#token, DRAFT_TIMEOUT_MS, DRAFT_VERIFY_MAX_CHARS)
      .catch(() => null)
    if (!state?.hasValue) return { delivered: false, reason: 'draft-drifted' }
    const owned = state.value.slice(this.#anchor, this.#anchor + this.#text.length)
    if (owned !== this.#text) return { delivered: false, reason: 'draft-drifted' }

    const edit = minimalEdit(this.#text, text)
    if (!edit) return { delivered: true }

    const aim = await bridge
      .setSelectedTextRange(
        this.#token,
        this.#anchor + edit.start,
        edit.end - edit.start,
        DRAFT_TIMEOUT_MS
      )
      .catch(() => null)
    if (
      !aim?.ok ||
      aim.selectionStart !== this.#anchor + edit.start ||
      aim.selectionLength !== edit.end - edit.start
    ) {
      return { delivered: false, reason: 'range-write-failed' }
    }

    const write = await bridge
      .setSelectedText(this.#token, edit.replacement, DRAFT_TIMEOUT_MS, DRAFT_VERIFY_MAX_CHARS)
      .catch(() => null)
    if (!write?.ok) return { delivered: false, reason: 'range-write-failed' }

    if (!(await this.regionHolds(text, write.after?.value ?? null))) {
      return { delivered: false, reason: 'range-write-failed' }
    }

    this.#text = text
    // Park the caret where the next word belongs. Best effort: a mid-text revision leaves the
    // caret at the end of the replacement otherwise, which is fine but surprising to watch.
    await bridge
      .setSelectedTextRange(this.#token, this.#anchor + text.length, 0, DRAFT_TIMEOUT_MS)
      .catch(() => null)
    return { delivered: true }
  }

  /** Whether the field's draft region reads as `expected`, allowing one settle for apps that
   *  mirror their text asynchronously. */
  private async regionHolds(expected: string, sameTripValue: string | null): Promise<boolean> {
    const matches = (value: string | null): boolean =>
      value !== null && value.slice(this.#anchor, this.#anchor + expected.length) === expected
    if (matches(sameTripValue)) return true

    await new Promise((resolve) => setTimeout(resolve, DRAFT_SETTLE_MS))
    const after = await this.#bridge
      .readElementState(this.#token, DRAFT_TIMEOUT_MS, DRAFT_VERIFY_MAX_CHARS)
      .catch(() => null)
    return after?.hasValue === true && matches(after.value)
  }
}
