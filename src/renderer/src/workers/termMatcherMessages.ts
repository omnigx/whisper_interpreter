/** Shared message types for termMatcher Web Worker. */

export type TermMatchHit = {
  foreignText: string
  chineseText: string
}

/** Scan mode aligned with main translation direction. */
export type TermScanMode = 'EN_ZH' | 'ZH_EN'

export type TermWorkerInMessage =
  | { type: 'INIT_TERMS'; payload: string }
  | { type: 'SCAN_TEXT'; payload: { text: string; mode: TermScanMode } }

export type TermWorkerOutMessage =
  | { type: 'INIT_DONE'; payload: { count: number } }
  | { type: 'MATCH_RESULT'; payload: TermMatchHit[] }
  | { type: 'ERROR'; payload: string }
