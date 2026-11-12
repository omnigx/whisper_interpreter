/**
 * Speech dictionary utilities — exact + pinyin fuzzy matching.
 */
import { pinyin } from 'pinyin-pro'

const SEPARATORS = /[,;；:：=＝]/
export const MIN_FROM_LEN = 2

export type SpeechDictMode = 'off' | 'exact' | 'fuzzy'

/** Parse quick-add input, return {from, to} or null */
export function parseDictInput(raw: string): { from: string; to: string } | null {
  const parts = raw.trim().split(SEPARATORS)
  if (parts.length < 2) return null
  const from = parts[0].trim()
  const to = parts.slice(1).join('').trim()
  if (!from || !to) return null
  if (from.length < MIN_FROM_LEN) return null
  return { from, to }
}

/** Exact substring replacement */
export function applySpeechDict(
  text: string,
  entries: Record<string, string>
): { text: string; corrections: Array<{ from: string; to: string }> } {
  if (!entries || Object.keys(entries).length === 0) return { text, corrections: [] }
  let result = text
  const corrections: Array<{ from: string; to: string }> = []
  for (const [from, to] of Object.entries(entries)) {
    if (result.includes(from)) {
      result = result.split(from).join(to)
      corrections.push({ from, to })
    }
  }
  return { text: result, corrections }
}

/** Get pinyin array for a string (no tones, one syllable per CJK char) */
function toPinyinArray(text: string): string[] {
  return pinyin(text, { toneType: 'none', type: 'array', nonZh: 'consecutive' })
}

/**
 * Pinyin fuzzy matching: match dictionary keys by pinyin sequence,
 * replacing the matched characters with the dictionary value.
 * "雇荣" (gu rong) matches key "固荣" (gu rong) → replaced with value.
 */
export function applySpeechDictFuzzy(
  text: string,
  entries: Record<string, string>
): { text: string; corrections: Array<{ from: string; to: string }> } {
  if (!entries || Object.keys(entries).length === 0) return { text, corrections: [] }

  const chars = Array.from(text)
  const charPinyins = toPinyinArray(text)
  if (charPinyins.length !== chars.length) {
    // Non-CJK text confuses the alignment; fall back to exact
    return applySpeechDict(text, entries)
  }

  const corrections: Array<{ from: string; to: string }> = []
  const replaced = new Array(chars.length)
  let anyMatch = false

  for (const [from, to] of Object.entries(entries)) {
    const keyPinyins = toPinyinArray(from)
    if (keyPinyins.length !== Array.from(from).length) continue // non-CJK key, skip fuzzy
    const keyLen = keyPinyins.length

    for (let i = 0; i <= chars.length - keyLen; i++) {
      // Skip if already replaced
      if (replaced[i]) continue
      let match = true
      for (let j = 0; j < keyLen; j++) {
        if (replaced[i + j] || charPinyins[i + j] !== keyPinyins[j]) {
          match = false
          break
        }
      }
      if (match) {
        const original = chars.slice(i, i + keyLen).join('')
        corrections.push({ from: original, to })
        replaced[i] = to
        for (let j = 1; j < keyLen; j++) replaced[i + j] = ''
        anyMatch = true
        i += keyLen - 1 // skip past this match
      }
    }
  }

  if (!anyMatch) return { text, corrections: [] }
  return { text: replaced.filter(c => c !== undefined && c !== '').join(''), corrections }
}
