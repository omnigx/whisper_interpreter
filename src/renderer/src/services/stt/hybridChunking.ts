/**
 * Hybrid chunking helpers for Paraformer streaming STT.
 * Mechanisms: punctuation / short silence / hard timeout.
 */

export type HybridSettleReason = 'punctuation' | 'silence' | 'max-duration' | 'manual'

/** Sentence-final punctuation (CN + EN) */
export const SENTENCE_END_RE = /[。？！.!?]/

export const DEFAULT_SILENCE_HOLD_MS = 300
export const DEFAULT_MAX_SENTENCE_MS = 10000
export const DEFAULT_SILENCE_RMS = 0.012

export interface PunctuationCut {
  /** Text through first sentence-end mark (inclusive) */
  head: string
  /** True when a sentence-end mark was found */
  hasEnd: boolean
  /** Remainder after the cut (may be empty) */
  rest: string
}

/** Cut partial text at the first sentence-ending punctuation. */
export function cutAtSentencePunctuation(text: string): PunctuationCut {
  const raw = text ?? ''
  const m = SENTENCE_END_RE.exec(raw)
  if (!m || m.index == null) {
    return { head: raw, hasEnd: false, rest: '' }
  }
  const end = m.index + m[0].length
  return {
    head: raw.slice(0, end).trimEnd(),
    hasEnd: true,
    rest: raw.slice(end).trimStart()
  }
}

export function hasSentencePunctuation(text: string): boolean {
  return SENTENCE_END_RE.test(text ?? '')
}
