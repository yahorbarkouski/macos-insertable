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
 * a value to verify against. Every update re-proves the world first (same live element, the
 * draft region still holding exactly what we last wrote) and refuses with a typed reason when
 * the user got there first — their keystrokes outrank our transcript.
 *
 * The hot path is ONE fused native trip (`casRangeEdit`): TypeScript computes the diff and
 * every offset, the native side executes compare→select→replace→verify→park atomically without
 * crossing back into JavaScript between steps.
 */

import type { NativeBridge } from './bridge.js'
import { wellFormed } from './sanitize.js'

/** Accessibility messaging timeout for the fused compare-and-swap trip. */
const DRAFT_TIMEOUT_MS = 400

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
        | 'element-changed'
        | 'element-gone'
        /** The field no longer holds what this draft last wrote — the user (or the app) edited
         *  the region. Their edit wins; take a fresh capture instead of fighting it. */
        | 'draft-drifted'
        /** The range could not be aimed or the replacement did not land. */
        | 'range-write-failed'
    }

export class Draft {
  #bridge: NativeBridge
  #token: string
  /** UTF-16 offset where the draft region begins in the field. */
  #anchor: number
  /** What this draft believes the field holds inside its region. */
  #text: string
  /** Where the last update parked the caret, or -1 while the caret is not ours to place —
   *  either before the first write, or after the user moved it away. */
  #expectedCaret = -1

  constructor(bridge: NativeBridge, token: string, anchor: number, initialText: string) {
    this.#bridge = bridge
    this.#token = token
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
   * Reconciles the draft region to `next` with one minimal range edit, executed as a SINGLE
   * fused native trip — prove focus, compare the region, replace the changed span, verify over
   * the region only (O(edit), never O(document)), park the caret. Equal text is a free no-op;
   * empty text deletes the region ("scratch that").
   *
   * Two checks the one-shot insert path performs are deliberately absent here, and their
   * absence is what the hot path's speed comes from:
   *
   * - No frontmost check. An Accessibility write lands on the element it references, so unlike
   *   the synthetic-event rungs there is nothing for a frontmost check to protect — and a
   *   draft that keeps streaming while the user glances at another window is the correct
   *   behavior, not a hazard.
   * - No identity attribute re-read. The region content precondition is strictly stronger: an
   *   application reusing the element object for a different field fails the content compare
   *   before any identity string could disagree.
   */
  public async update(next: string): Promise<DraftUpdateResult> {
    const bridge = this.#bridge
    const text = wellFormed(next)

    if (!bridge.isAccessibilityTrusted()) return { delivered: false, reason: 'no-permission' }
    if (bridge.isSecureInputEnabled()) return { delivered: false, reason: 'secure-input' }

    const edit = minimalEdit(this.#text, text)
    if (!edit) return { delivered: true }

    const result = await bridge
      .casRangeEdit(
        this.#token,
        this.#anchor,
        this.#text,
        edit.start,
        edit.end,
        edit.replacement,
        this.#anchor + text.length,
        this.#expectedCaret,
        DRAFT_TIMEOUT_MS
      )
      .catch(() => null)

    if (!result?.ok) {
      switch (result?.reason) {
        case 'element-changed':
          return { delivered: false, reason: 'element-changed' }
        case 'region-mismatch':
          return { delivered: false, reason: 'draft-drifted' }
        case 'select-failed':
        case 'write-failed':
        case 'verify-failed':
          return { delivered: false, reason: 'range-write-failed' }
        default:
          return { delivered: false, reason: 'element-gone' }
      }
    }

    this.#text = text
    // A skipped park means the user moved the caret; it stops being ours until they happen to
    // put it back where we would have left it.
    this.#expectedCaret = result.parked ? this.#anchor + text.length : this.#expectedCaret
    return { delivered: true }
  }
}
