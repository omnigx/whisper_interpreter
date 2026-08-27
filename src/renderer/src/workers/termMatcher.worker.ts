/// <reference lib="webworker" />
import Papa from 'papaparse'
import AhoCorasick from 'modern-ahocorasick'
import type {
  TermMatchHit,
  TermScanMode,
  TermWorkerInMessage,
  TermWorkerOutMessage
} from './termMatcherMessages'

declare const self: DedicatedWorkerGlobalScope

type TermRecord = { foreignText: string; chineseText: string }

/** EN key (lowercase) → full term */
let enToTerm = new Map<string, TermRecord>()
/** ZH key → full term */
let zhToTerm = new Map<string, TermRecord>()
let enTree: AhoCorasick | null = null
let zhTree: AhoCorasick | null = null

function rebuildTrees(): void {
  const enKeys = Array.from(enToTerm.keys()).filter((k) => k.length > 0)
  const zhKeys = Array.from(zhToTerm.keys()).filter((k) => k.length > 0)
  enTree = enKeys.length > 0 ? new AhoCorasick(enKeys) : null
  zhTree = zhKeys.length > 0 ? new AhoCorasick(zhKeys) : null
}

function initFromCsv(csvText: string): number {
  const parsed = Papa.parse<string[]>(csvText, {
    header: false,
    skipEmptyLines: true,
    dynamicTyping: false
  })

  enToTerm = new Map()
  zhToTerm = new Map()

  for (const row of parsed.data) {
    if (!Array.isArray(row) || row.length < 2) continue
    const foreign = String(row[0] ?? '').trim()
    const chinese = String(row[1] ?? '').trim()
    if (!foreign || !chinese) continue
    if (
      /^(en|english|foreign|term|source|原文)/i.test(foreign) &&
      /^(zh|cn|chinese|中文|译文|target)/i.test(chinese)
    ) {
      continue
    }
    const record: TermRecord = { foreignText: foreign, chineseText: chinese }
    enToTerm.set(foreign.toLowerCase(), record)
    zhToTerm.set(chinese, record)
  }

  rebuildTrees()
  return enToTerm.size
}

function collectHits(
  tree: AhoCorasick | null,
  haystack: string,
  lookup: Map<string, TermRecord>,
  normalizeKey: (k: string) => string
): TermMatchHit[] {
  if (!tree || !haystack) return []

  const results = tree.search(haystack) as [number, string[]][]
  const seen = new Set<string>()
  const hits: TermMatchHit[] = []

  for (const [, keywords] of results) {
    for (const kw of keywords) {
      const record = lookup.get(normalizeKey(kw))
      if (!record) continue
      const dedupeKey = record.foreignText.toLowerCase()
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      hits.push({
        foreignText: record.foreignText,
        chineseText: record.chineseText
      })
    }
  }

  return hits
}

function scanText(text: string, mode: TermScanMode): TermMatchHit[] {
  if (mode === 'EN_ZH') {
    // Only match English terms in STT source — avoid re-hitting Chinese translation
    return collectHits(enTree, text.toLowerCase(), enToTerm, (k) => k.toLowerCase())
  }
  // ZH_EN: match Chinese terms in STT source
  return collectHits(zhTree, text, zhToTerm, (k) => k)
}

function reply(msg: TermWorkerOutMessage): void {
  self.postMessage(msg)
}

self.onmessage = (ev: MessageEvent<TermWorkerInMessage>): void => {
  const data = ev.data
  try {
    if (data.type === 'INIT_TERMS') {
      const count = initFromCsv(data.payload)
      reply({ type: 'INIT_DONE', payload: { count } })
      return
    }
    if (data.type === 'SCAN_TEXT') {
      const { text, mode } = data.payload
      reply({ type: 'MATCH_RESULT', payload: scanText(text, mode) })
    }
  } catch (e) {
    reply({
      type: 'ERROR',
      payload: e instanceof Error ? e.message : String(e)
    })
  }
}
