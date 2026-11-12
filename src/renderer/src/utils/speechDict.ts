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

/** Max entries / lengths accepted when importing a JSON dictionary file */
export const MAX_DICT_ENTRIES = 500
export const MAX_TERM_LEN = 30

/**
 * Normalize a parsed JSON payload into a clean dict. Accepts:
 *  - object: { "原词": "纠正词" } or self-map { "术语": "术语" } (target-word form for fuzzy mode)
 *  - array:  ["术语", ...] → self-map entries
 * Mixed formats merge naturally: key=value is a no-op in exact mode and the
 * target-word form in fuzzy mode. Malformed input yields {} — never throws.
 * Defense: strings only, trimmed, key ≥ MIN_FROM_LEN (single char over-corrects
 * in fuzzy mode), each side ≤ MAX_TERM_LEN, ≤ MAX_DICT_ENTRIES entries.
 */
export function normalizeDictJson(parsed: unknown): Record<string, string> {
  const raw: Array<[string, unknown]> = Array.isArray(parsed)
    ? parsed.map((v): [string, unknown] => [typeof v === 'string' ? v : '', v])
    : parsed && typeof parsed === 'object'
      ? Object.entries(parsed as Record<string, unknown>)
      : []
  const clean: Record<string, string> = {}
  for (const [k, v] of raw) {
    if (Object.keys(clean).length >= MAX_DICT_ENTRIES) break
    const key = k.trim()
    const val = typeof v === 'string' ? v.trim() : ''
    if (!key || !val) continue
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue // 原型污染防御
    if (key.length < MIN_FROM_LEN || key.length > MAX_TERM_LEN || val.length > MAX_TERM_LEN) continue
    clean[key] = val
  }
  return clean
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
  // replaced 保留全文：未命中位留原字符，命中位写纠正词（后续被消耗位留空串）。
  // 旧版未命中位是 undefined 且返回时被 filter 滤掉，导致整句只剩纠正词。
  const replaced = [...chars]
  const consumed = new Array<boolean>(chars.length).fill(false)
  let anyMatch = false

  for (const [from, to] of Object.entries(entries)) {
    const keyPinyins = toPinyinArray(from)
    if (keyPinyins.length !== Array.from(from).length) continue // non-CJK key, skip fuzzy
    const keyLen = keyPinyins.length

    for (let i = 0; i <= chars.length - keyLen; i++) {
      // Skip if already consumed by an earlier match
      if (consumed[i]) continue
      let match = true
      for (let j = 0; j < keyLen; j++) {
        if (consumed[i + j] || charPinyins[i + j] !== keyPinyins[j]) {
          match = false
          break
        }
      }
      if (match) {
        const original = chars.slice(i, i + keyLen).join('')
        corrections.push({ from: original, to })
        replaced[i] = to
        for (let j = 1; j < keyLen; j++) replaced[i + j] = ''
        for (let j = 0; j < keyLen; j++) consumed[i + j] = true
        anyMatch = true
        i += keyLen - 1 // skip past this match
      }
    }
  }

  if (!anyMatch) return { text, corrections: [] }
  return { text: replaced.join(''), corrections }
}
