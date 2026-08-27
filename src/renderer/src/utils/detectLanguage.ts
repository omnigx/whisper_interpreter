/** Character-weighted CJK vs Latin detector for Auto-LID */

export type DetectedLanguage = 'zh' | 'en' | 'unknown'

/**
 * Fast client-side language guess.
 * Chinese characters count as heavier units than Latin letters
 * (one Han char ≈ a word; English needs multiple letters).
 */
export function detectLanguage(text: string): DetectedLanguage {
  const zhMatches = text.match(/[\u4e00-\u9fa5]/g) || []
  const enMatches = text.match(/[a-zA-Z]/g) || []

  // Character counts (not runs) for the 1/3 weight rule
  const zhCount = zhMatches.length
  const enCount = enMatches.length

  if (zhCount > 0 && zhCount >= enCount / 3) {
    return 'zh'
  }
  if (enCount > zhCount) {
    return 'en'
  }
  return 'unknown'
}
