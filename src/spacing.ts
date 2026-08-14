/**
 * Fitting inserted text to the text already around it.
 *
 * Dictated text arrives without knowing where it lands. Inserted verbatim after "Hello" it
 * reads "Helloworld"; inserted after "Hello " it reads "Hello  world"; inserted after "re-" a
 * naive space breaks the word. The fix is one decision made twice — does this boundary need a
 * separator? — against the characters actually on each side.
 *
 * Everything here is pure and synchronous. It answers only about whitespace: it never changes
 * the caller's words, punctuation, or capitalization, because a library that silently rewrites
 * what it was told to insert is a library nobody can reason about.
 *
 * Three properties this aims for, in order:
 *
 *  - **Correct in every script.** A space between two Han characters is a typographic error,
 *    not a nicety. Script rules come from Unicode itself (`Script_Extensions`), so scripts and
 *    their shared punctuation are covered without a hand-maintained code-point table to fall
 *    behind the standard.
 *  - **Idempotent.** No trailing separator is ever added at the end of a field. Consecutive
 *    insertions still separate correctly — the *next* insertion sees a word character behind it
 *    and adds its own leading space — and a user who stops dictating is not left with dangling
 *    whitespace. Fitting an already-fitted insertion changes nothing.
 *  - **Conservative.** Where the right answer is genuinely ambiguous, the surrounding text is
 *    left to speak for itself rather than guessed at.
 */

/**
 * Characters that occupy no width and never constitute content: zero-width spaces and joiners,
 * soft hyphens, bidi controls, variation selectors, the byte-order mark.
 *
 * They must be skipped before judging a boundary, and the reason is concrete: some applications
 * park one at an empty insertion point as an accessibility placeholder — a Google Docs field
 * that is visibly empty reports a lone zero-width space — which would otherwise read as real
 * preceding content and suppress a separator that was wanted. `Default_Ignorable_Code_Point` is
 * Unicode's own name for exactly this class.
 */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u

/**
 * Scripts that do not separate words with spaces. Matching on `Script_Extensions` rather than
 * `Script` is deliberate: it also covers the punctuation these scripts share, so an ideographic
 * full stop counts as Han rather than as neutral punctuation.
 */
const NO_SPACE_SCRIPT =
  /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Bopomofo}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}\p{scx=Tai_Tham}\p{scx=Tibetan}\p{scx=Javanese}\p{scx=Balinese}]/u

/**
 * Punctuation that belongs to the word *before* it, so text starting with one needs no
 * separator: closing brackets and quotes, clause and sentence terminators, the possessive
 * apostrophe, percent signs.
 *
 * Opening punctuation is deliberately absent — dictating `(aside)` after a word wants
 * "word (aside)", not "word(aside)" — and so are symbols generally: `$5` and an emoji both read
 * better with the space they would otherwise lose.
 */
const HUGS_PRECEDING = /[\p{Pe}\p{Pf},.!?;:…、。，．！？；：%‰'’]/u

/**
 * Punctuation that belongs to the word *after* it, so text following one needs no separator:
 * opening brackets and quotes, and the Spanish inverted marks that open a clause.
 */
const HUGS_FOLLOWING = /[\p{Ps}\p{Pi}"'`¿¡]/u

/**
 * Characters that join two tokens into one, checked only on the left of a boundary: a caret
 * sitting after "re-", "src/" or "@" is mid-token, and a separator there breaks the token in
 * half.
 *
 * Left-only on purpose. The same characters *leading* an insertion usually mean something else
 * — an em dash opens an aside ("Hello — and then"), a leading hyphen is a list bullet or a
 * minus sign — and all of those want their space.
 */
const JOINS_ACROSS = /[\p{Pd}\p{Pc}/\\@~]/u

const WHITESPACE = /\s/u

/**
 * How many code units of each side to examine. A boundary decision needs the last visible
 * character and, at most, the run of punctuation in front of it — never the document. Bounding
 * the window keeps the cost of fitting independent of how much text the field holds.
 */
const BOUNDARY_WINDOW = 32

/** The text surrounding where an insertion will land. Omit a side that cannot be read. */
export interface InsertionContext {
  /** Text immediately before the insertion point. */
  before?: string | undefined
  /** Text immediately after it. Omitting this is different from passing `''`: an empty string
   *  means "the field ends here", which is what suppresses a trailing separator. */
  after?: string | undefined
}

/**
 * Returns `text` with leading and trailing whitespace adjusted to read correctly against its
 * surroundings — nothing else about it is touched.
 *
 * ```ts
 * fitSpacing('world', { before: 'Hello', after: '' })   // ' world'
 * fitSpacing('world', { before: 'Hello ', after: '' })  // 'world'   (already separated)
 * fitSpacing('enable', { before: 're-', after: '' })    // 'enable'  (mid-token)
 * fitSpacing('世界', { before: '你好', after: '' })      // '世界'    (Han takes no spaces)
 * fitSpacing('brave', { before: 'Hello', after: 'world' }) // ' brave '
 * ```
 */
export function fitSpacing(text: string, context: InsertionContext): string {
  // The caller's own edges are advisory: they carry whatever the transcriber emitted, and the
  // surrounding text is the better authority. Interior whitespace is left exactly as given.
  const core = text.replace(/^\s+/u, '').replace(/\s+$/u, '')
  if (!core) return ''

  const lead = context.before === undefined ? '' : separator(context.before, core)
  // No trailing separator at the end of a field: the next insertion adds its own leading one,
  // so consecutive dictation still separates while a finished one leaves no dangling space.
  const tail =
    context.after === undefined || !hasVisibleContent(context.after)
      ? ''
      : separator(core, context.after)
  return lead + core + tail
}

/** A single space when the boundary between `left` and `right` needs one, otherwise nothing. */
function separator(left: string, right: string): string {
  const leftEdge = lastVisibleChar(left)
  const rightEdge = firstVisibleChar(right)

  // Nothing on one side to separate from — the start of a field, or an insertion of pure
  // whitespace that has already been reduced to nothing.
  if (leftEdge === undefined || rightEdge === undefined) return ''

  // Already separated by the author's own whitespace.
  if (WHITESPACE.test(leftEdge) || WHITESPACE.test(rightEdge)) return ''

  // Either side written in a script that does not space its words.
  if (endsInNoSpaceScript(left) || startsWithNoSpaceScript(right)) return ''

  if (HUGS_PRECEDING.test(rightEdge)) return ''
  if (HUGS_FOLLOWING.test(leftEdge)) return ''
  if (JOINS_ACROSS.test(leftEdge)) return ''

  return ' '
}

/** True when the string holds anything a reader would see. */
function hasVisibleContent(text: string): boolean {
  return firstVisibleChar(text) !== undefined
}

/** The last character of `text` that is not invisible, or undefined when there is none. */
function lastVisibleChar(text: string): string | undefined {
  for (const char of charsFromEnd(text.slice(-BOUNDARY_WINDOW))) {
    if (!IGNORABLE.test(char)) return char
  }
  return undefined
}

/** The first character of `text` that is not invisible, or undefined when there is none. */
function firstVisibleChar(text: string): string | undefined {
  for (const char of text.slice(0, BOUNDARY_WINDOW)) {
    if (!IGNORABLE.test(char)) return char
  }
  return undefined
}

/**
 * Whether the text ends in a script that takes no spaces, looking past any trailing punctuation
 * so that a sentence closed with an ideographic full stop is still recognised as Han. Stops at
 * the first real content character: one Latin word at the end means the boundary is Latin, no
 * matter what precedes it.
 */
function endsInNoSpaceScript(text: string): boolean {
  return scansToNoSpaceScript(charsFromEnd(text.slice(-BOUNDARY_WINDOW)))
}

function startsWithNoSpaceScript(text: string): boolean {
  return scansToNoSpaceScript(text.slice(0, BOUNDARY_WINDOW))
}

function scansToNoSpaceScript(chars: Iterable<string>): boolean {
  for (const char of chars) {
    if (NO_SPACE_SCRIPT.test(char)) return true
    // Punctuation and invisibles stand between the boundary and the content that decides it.
    if (IGNORABLE.test(char) || WHITESPACE.test(char) || isNeutralPunctuation(char)) continue
    return false
  }
  return false
}

/** Punctuation that belongs to no script in particular, and so decides nothing on its own. */
function isNeutralPunctuation(char: string): boolean {
  return /[\p{P}\p{S}]/u.test(char)
}

/** Iterates a string's characters from the end, keeping surrogate pairs intact. */
function* charsFromEnd(text: string): Generator<string> {
  let end = text.length
  while (end > 0) {
    const codeUnit = text.charCodeAt(end - 1)
    // A low surrogate belongs to the high surrogate in front of it; taking it alone would hand
    // the caller half a character.
    const isTrailSurrogate = codeUnit >= 0xdc00 && codeUnit <= 0xdfff
    const start = isTrailSurrogate && end >= 2 ? end - 2 : end - 1
    yield text.slice(start, end)
    end = start
  }
}
