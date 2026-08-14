/**
 * Text read out of another process can carry unpaired surrogates — the native layer truncates on
 * UTF-16 boundaries, and applications hand back whatever they hold. An unpaired surrogate throws
 * on `JSON.stringify`, so every string that crosses out of the bridge is made well-formed first.
 */
export function wellFormed(text: string): string {
  return text.toWellFormed()
}
