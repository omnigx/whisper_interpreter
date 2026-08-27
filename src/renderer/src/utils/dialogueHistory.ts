import type {
  DialoguePair,
  TranscriptSegment,
  TranslationSegment
} from '@shared/types'

/**
 * Join final transcripts with their translations into timed dialogue pairs.
 * Prefer translation.timestamp when present (STT+LLM combined moment).
 */
export function buildDialogueHistory(
  transcripts: TranscriptSegment[],
  translations: TranslationSegment[]
): DialoguePair[] {
  const bySource = new Map<string, TranslationSegment>()
  for (const tr of translations) {
    const prev = bySource.get(tr.sourceId)
    if (!prev || tr.timestamp >= prev.timestamp) {
      bySource.set(tr.sourceId, tr)
    }
  }

  const pairs: DialoguePair[] = []

  for (const t of transcripts) {
    if (!t.text.trim()) continue
    const tr = bySource.get(t.id)
    pairs.push({
      id: t.id,
      sttText: t.text,
      translatedText: tr?.text ?? '',
      lang: t.lang ?? tr?.lang,
      timestamp: tr?.timestamp ?? t.timestamp
    })
  }

  // Orphan translations (e.g. DictationTest id mismatch) — append if not linked
  for (const tr of translations) {
    if (transcripts.some((t) => t.id === tr.sourceId)) continue
    if (!tr.text.trim() && !tr.streaming) continue
    pairs.push({
      id: tr.id,
      sttText: '',
      translatedText: tr.text,
      lang: tr.lang,
      timestamp: tr.timestamp
    })
  }

  return pairs.sort((a, b) => a.timestamp - b.timestamp)
}

export function filterDialogueForSubtitle(
  pairs: DialoguePair[],
  opts: {
    displayMode: 'count' | 'time'
    countLimit: number
    timeLimit: number
    now?: number
  }
): DialoguePair[] {
  const now = opts.now ?? Date.now()
  if (opts.displayMode === 'time') {
    const windowMs = Math.max(5, Math.min(45, opts.timeLimit)) * 1000
    return pairs.filter((p) => now - p.timestamp <= windowMs)
  }
  const n = Math.max(1, Math.min(5, opts.countLimit))
  return pairs.slice(-n)
}
