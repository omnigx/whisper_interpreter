import { detectLanguage } from './detectLanguage'

/** Map LLM source/target pair into foreign-on-top / Chinese-below fields. */
export function pairToTermTexts(
  source: string,
  target: string
): { foreignText: string; chineseText: string } {
  const s = source.trim()
  const t = target.trim()
  const sLang = detectLanguage(s)
  const tLang = detectLanguage(t)

  if (sLang === 'zh' && tLang !== 'zh') {
    return { foreignText: t, chineseText: s }
  }
  if (tLang === 'zh' && sLang !== 'zh') {
    return { foreignText: s, chineseText: t }
  }
  // Prompt default: source = foreign, target = Chinese
  return { foreignText: s, chineseText: t }
}

export function sortTerms<T extends { isPinned: boolean; timestamp: number }>(
  terms: T[]
): T[] {
  return [...terms].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
    return b.timestamp - a.timestamp
  })
}
