/**
 * Speech dictionary utilities — separated from the component to keep
 * pipeline imports JSX-free.
 */

const SEPARATORS = /[,;；:：=＝]/
export const MIN_FROM_LEN = 2

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

/** Apply speech dictionary corrections to text */
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
