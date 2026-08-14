import { describe, expect, it } from 'vitest'

import { fitSpacing } from '../src/spacing.js'

/** Reads as the field would: what the user ends up looking at. */
function fieldAfterInsert(before: string, text: string, after: string): string {
  return before + fitSpacing(text, { before, after }) + after
}

describe('fitSpacing — the ordinary cases', () => {
  it('separates two words', () => {
    expect(fieldAfterInsert('Hello', 'world', '')).toBe('Hello world')
  })

  it('does not double a separator the field already has', () => {
    expect(fieldAfterInsert('Hello ', 'world', '')).toBe('Hello world')
  })

  it('does not double a separator the text already has', () => {
    expect(fieldAfterInsert('Hello', ' world', '')).toBe('Hello world')
  })

  it('adds nothing at the start of an empty field', () => {
    expect(fieldAfterInsert('', 'Hello', '')).toBe('Hello')
  })

  it('separates on both sides when inserting mid-sentence', () => {
    expect(fieldAfterInsert('Hello', 'brave', 'world')).toBe('Hello brave world')
  })

  it('leaves interior whitespace of the insertion alone', () => {
    expect(fitSpacing('two  spaces\tand a tab', { before: '', after: '' })).toBe(
      'two  spaces\tand a tab'
    )
  })

  it('contributes nothing for text that is only whitespace', () => {
    expect(fitSpacing('   ', { before: 'Hello', after: '' })).toBe('')
  })
})

describe('fitSpacing — punctuation attaches to the right side of it', () => {
  it('does not separate a clause terminator from the word it follows', () => {
    expect(fieldAfterInsert('Hello', ', and then', '')).toBe('Hello, and then')
  })

  it.each([')', ']', '}', '”', '’', '.', '!', '?', ';', ':', '%'])(
    'text beginning with %s hugs the preceding word',
    (mark) => {
      expect(fieldAfterInsert('Hello', `${mark}x`, '')).toBe(`Hello${mark}x`)
    }
  )

  it('keeps a possessive attached', () => {
    expect(fieldAfterInsert('it', "'s mine", '')).toBe("it's mine")
  })

  it('separates text that OPENS a bracket or quote', () => {
    // Amical suppresses this: their rule treats all punctuation on the right as hugging, so
    // "Hello(aside)" — an opener belongs to what follows it, not what precedes it.
    expect(fieldAfterInsert('Hello', '(aside)', '')).toBe('Hello (aside)')
    expect(fieldAfterInsert('Hello', '"quoted"', '')).toBe('Hello "quoted"')
  })

  it('separates an emoji rather than gluing it to the last word', () => {
    // Emoji sit in the symbol category, which a blanket punctuation-or-symbol rule suppresses.
    expect(fieldAfterInsert('Hello', '👋', '')).toBe('Hello 👋')
  })

  it('separates a currency amount', () => {
    expect(fieldAfterInsert('costs', '$5', '')).toBe('costs $5')
  })
})

describe('fitSpacing — punctuation attaches to the left side of it', () => {
  it.each(['(', '[', '{', '“', '‘', '"', '`', '¿', '¡'])('text following %s hugs it', (mark) => {
    expect(fieldAfterInsert(`x${mark}`, 'hello', '')).toBe(`x${mark}hello`)
  })
})

describe('fitSpacing — tokens joined across the boundary', () => {
  it('does not break a hyphenated word', () => {
    // Amical inserts a space here: a hyphen is not in their opening-punctuation set, so
    // "re- enable".
    expect(fieldAfterInsert('re-', 'enable', '')).toBe('re-enable')
  })

  it('does not break a path', () => {
    expect(fieldAfterInsert('src/', 'index.ts', '')).toBe('src/index.ts')
  })

  it('does not break an identifier or handle', () => {
    expect(fieldAfterInsert('snake_', 'case', '')).toBe('snake_case')
    expect(fieldAfterInsert('@', 'mention', '')).toBe('@mention')
  })

  it('still separates when the joining character LEADS the insertion', () => {
    // An em dash opens an aside; a leading hyphen is a bullet or a minus. Only the left side
    // of a boundary joins.
    expect(fieldAfterInsert('Hello', '— and then', '')).toBe('Hello — and then')
    expect(fieldAfterInsert('Hello', '-1', '')).toBe('Hello -1')
  })

  it('separates after a sentence-ending period', () => {
    // A period joins in "example.com" but terminates far more often; terminating wins.
    expect(fieldAfterInsert('Done.', 'Next sentence', '')).toBe('Done. Next sentence')
  })
})

describe('fitSpacing — scripts that do not space their words', () => {
  it('inserts no space between Han characters', () => {
    expect(fieldAfterInsert('你好', '世界', '')).toBe('你好世界')
  })

  it('looks past an ideographic full stop to the Han text behind it', () => {
    expect(fieldAfterInsert('你好。', '再见', '')).toBe('你好。再见')
  })

  it.each([
    ['こんにちは', '世界'],
    ['ありがとう', 'ございます'],
    ['สวัสดี', 'ครับ'],
    ['ສະບາຍດີ', 'ເຈົ້າ'],
    ['မင်္ဂလာပါ', 'ခင်ဗျာ']
  ])('inserts no space between %s and %s', (before, text) => {
    expect(fieldAfterInsert(before, text, '')).toBe(before + text)
  })

  it('inserts no space when only ONE side is a no-space script', () => {
    // Mixed text follows the stricter side; a space against Han reads as an error either way.
    expect(fieldAfterInsert('你好', 'world', '')).toBe('你好world')
    expect(fieldAfterInsert('Hello', '世界', '')).toBe('Hello世界')
  })

  it('still spaces Korean, which does separate its words', () => {
    expect(fieldAfterInsert('안녕하세요', '세계', '')).toBe('안녕하세요 세계')
  })

  it('does not let Han earlier in the field make a Latin boundary Han', () => {
    // The scan stops at the first real content character; only the boundary decides.
    expect(fieldAfterInsert('你好 world', 'again', '')).toBe('你好 world again')
  })
})

describe('fitSpacing — invisible characters', () => {
  it('treats a field holding only a zero-width space as empty', () => {
    // Measured in the field: some applications park one at an empty insertion point as an
    // accessibility placeholder, which would otherwise read as real preceding content.
    expect(fitSpacing('Hello', { before: '​', after: '' })).toBe('Hello')
  })

  it('looks past invisibles to the real character behind them', () => {
    expect(fitSpacing('world', { before: 'Hello​﻿', after: '' })).toBe(' world')
  })

  it('treats a trailing-only invisible after the caret as the end of the field', () => {
    expect(fitSpacing('Hello', { before: '', after: '​' })).toBe('Hello')
  })

  it.each(['­', '‍', '﻿', '‪', '️'])('ignores %s at a boundary', (invisible) => {
    expect(fitSpacing('world', { before: `Hello${invisible}`, after: '' })).toBe(' world')
  })
})

describe('fitSpacing — trailing separators and idempotence', () => {
  it('never leaves a dangling space at the end of a field', () => {
    // The trailing space other implementations add is visible sloppiness if the user stops
    // dictating here; the next insertion adds its own leading space instead.
    expect(fitSpacing('Hello', { before: '', after: '' })).toBe('Hello')
    expect(fitSpacing('world', { before: 'Hello', after: '' })).toBe(' world')
  })

  it('separates consecutive insertions correctly without one', () => {
    let field = ''
    for (const word of ['First', 'second', 'third']) {
      field += fitSpacing(word, { before: field, after: '' })
    }
    expect(field).toBe('First second third')
  })

  it('is idempotent — fitting an already-fitted insertion changes nothing', () => {
    const once = fitSpacing('world', { before: 'Hello', after: '' })
    const twice = fitSpacing(once, { before: 'Hello', after: '' })
    expect(twice).toBe(once)
  })

  it('adds a trailing separator only when real text follows', () => {
    expect(fitSpacing('brave', { before: 'Hello', after: 'world' })).toBe(' brave ')
    expect(fitSpacing('brave', { before: 'Hello', after: ' world' })).toBe(' brave')
  })
})

describe('fitSpacing — unknown context', () => {
  it('leaves a side alone when it cannot be read', () => {
    // An opaque surface reports nothing; guessing there would be inventing context.
    expect(fitSpacing('world', {})).toBe('world')
    expect(fitSpacing('world', { before: 'Hello' })).toBe(' world')
    expect(fitSpacing('world', { after: 'now' })).toBe('world ')
  })
})

describe('fitSpacing — surrogate pairs', () => {
  it('reads a trailing emoji as one character, not half of one', () => {
    expect(fieldAfterInsert('Nice 👍', 'work', '')).toBe('Nice 👍 work')
  })

  it('reads a leading astral character correctly', () => {
    expect(fieldAfterInsert('Hello', '𝐰orld', '')).toBe('Hello 𝐰orld')
  })

  it('never returns text containing a lone surrogate', () => {
    const fitted = fitSpacing('𝐰ord', { before: 'a👍', after: '👍b' })
    expect(fitted).toBe(fitted.toWellFormed())
  })
})
