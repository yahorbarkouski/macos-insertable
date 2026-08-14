/**
 * The public vocabulary. Everything a caller can learn or attempt is expressed as a discriminated
 * union — a refusal is data with a reason, never a bare `false` the caller has to guess about.
 */

import type { AppIdentity, NativeBridge } from './bridge.js'

export type { AppIdentity }

/**
 * How the focused element holds its text, which decides how insertion works:
 *
 * - `readable` — the element exposes its text and a writable selection. Insertion is a precise
 *   Accessibility write, verified by reading the element back.
 * - `opaque` — the element behaves like a text editor but its text lives elsewhere (a canvas or
 *   model-backed editor, an IME decoy). Insertion is aimed trusted input — clipboard paste or
 *   synthetic keystrokes — and cannot be verified by read-back.
 */
export type Surface = 'readable' | 'opaque'

/** What kind of control the element is, from its advertised role. */
export type FieldKind = 'field' | 'area' | 'container'

export interface FieldInfo {
  kind: FieldKind
  surface: Surface
  /** What the application calls this field, first non-empty of title/placeholder/description.
   *  UNTRUSTED and capped — an application can put anything here. */
  label: string
  /** What the field expects (`search`, `url`, `email`), from the platform's own subrole. */
  purposeHint: string
  /** Whether the field is built to hold more than a line. */
  multiline: boolean
  /** The field's text. Empty for `opaque` surfaces — scratch text is not the document. */
  value: string
  selectionStart: number | null
  selectionEnd: number | null
  selectedText: string
  readOnly: boolean
  /** Role/subrole/identifier fingerprint, re-checked before any write. */
  identity: string
}

/** Everything a capture can conclude about the focused element of an application. */
export type Capture =
  | { status: 'field'; app: AppIdentity; field: FieldInfo }
  /** A password or one-time-code field. Deliberately never captured: its text must not reach
   *  this process and no insertion will be attempted. */
  | { status: 'secure-field'; app: AppIdentity }
  | { status: 'disabled'; app: AppIdentity; role: string }
  /** Something is focused, but it does not behave like a place text goes. */
  | { status: 'not-a-field'; app: AppIdentity; role: string; subrole: string }
  /** The application reports no focused element at all — common for Chromium-backed apps that
   *  have not built their accessibility tree. `app` is null only when there was no frontmost
   *  application to ask. */
  | { status: 'no-element'; app: AppIdentity | null }
  /** The macOS Accessibility permission has not been granted to this process. */
  | { status: 'no-permission' }
  /** Not macOS, or the native addon is not built. */
  | { status: 'unsupported' }

export interface CaptureOptions {
  /** Application to read. Defaults to the frontmost application. */
  pid?: number
  /** Accessibility messaging timeout per call into the target app. */
  timeoutMs?: number
  /** Cap on how much field text is copied out. */
  valueMaxChars?: number
  /** Override the platform backend — the seam tests and future backends plug into. */
  bridge?: NativeBridge
}

/** Where the text should go, relative to the field's state at capture. */
export type InsertMode = 'caret' | 'selection' | 'all'

/**
 * How to deliver. `auto` climbs the ladder — precise Accessibility write where the surface is
 * readable, then clipboard paste, then synthetic keystrokes. Forcing a rung is for callers with
 * their own knowledge of the target.
 */
export type InsertStrategy = 'auto' | 'clipboard' | 'keystrokes'

export interface InsertOptions {
  mode?: InsertMode
  strategy?: InsertStrategy
  /**
   * Wait up to this long for the user to release modifier keys before posting synthetic input.
   * A chord still physically held while a paste goes out can turn ⌘V into ⌘⇧V or worse — the
   * classic hold-to-talk hazard, where delivery fires the instant the hotkey is released.
   * Ignored by the Accessibility rung, which posts no events. Default 300ms; 0 disables.
   */
  waitForModifiersMs?: number
}

/** The rung that actually delivered. */
export type DeliveredVia = 'accessibility' | 'clipboard' | 'keystrokes'

export type InsertRefusal =
  /** Empty text is a no-op, not a delivery. */
  | 'empty-text'
  | 'no-permission'
  /** Secure Event Input is active system-wide — a password field is up somewhere. */
  | 'secure-input'
  /** The user switched applications after capture. */
  | 'app-changed'
  /** Focus moved to a different element than the one captured. */
  | 'element-changed'
  /** The captured element could not be re-read at all. */
  | 'element-gone'
  | 'read-only'
  | 'element-disabled'
  /** `caret` mode, but a selection now exists that the insert would destroy. */
  | 'selection-in-the-way'
  /** `selection` mode, but no selection was captured to replace. */
  | 'no-selection'
  /** `all` mode on an opaque surface — replacing a document that cannot be read back is
   *  destruction, not an edit. */
  | 'unreadable-replace-all'
  /** The paste keystroke could not be posted — the target app lost frontmost. */
  | 'paste-not-posted'
  /** The field was read back after the paste and demonstrably did not change. */
  | 'paste-did-not-land'
  /** Synthetic typing failed or the payload exceeds the typing ceiling. */
  | 'type-failed'
  /** The capture handle was already released. */
  | 'released'
  /** The user was still holding modifier keys when the wait expired; posting a chord under
   *  them would have produced a different shortcut. */
  | 'modifiers-held'

export type InsertResult =
  | { delivered: true; via: DeliveredVia }
  | { delivered: false; reason: InsertRefusal }

/** Permission and environment state, checked without touching any other process. */
export interface Access {
  /** True on macOS with the native addon built. */
  supported: boolean
  /** The Accessibility (TCC) grant every read and write requires. */
  trusted: boolean
  /** True while any application holds a password field open; synthetic input is suppressed. */
  secureInput: boolean
  /**
   * Which application holds the secure-input grab, when `secureInput` is true and macOS will
   * say — so the message can be "quit the password prompt in 1Password" instead of "a password
   * field is open somewhere". Best effort: the pid can be absent or wrong for a grab taken
   * while the holder was in the background.
   */
  secureInputHolder: { pid: number; name: string; bundleId: string } | null
}

/**
 * Delivering into a terminal is not like delivering into a text box: the shell executes on
 * newlines, so multi-line text runs commands the user never typed, and a submit chord runs
 * whatever sits on the line. Callers that dictate into terminals should gate on this.
 */
export interface TargetTraits {
  /** The target application looks like a terminal emulator, by bundle identifier. */
  terminal: boolean
}
