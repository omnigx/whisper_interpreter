/**
 * Semantic text buffer for STT → LLM triggering.
 * Dual criteria: sentence-final punctuation OR max-duration fallback,
 * plus silence idle flush.
 */

export type SemanticFlushReason =
  | 'punctuation'
  | 'max-duration'
  | 'silence'
  | 'manual'

export interface SemanticChunkerOptions {
  /** Max seconds a sentence may stay in buffer (5–30) */
  maxDurationSec?: number
  /** Idle time without new text before force flush (ms), default 2000 */
  silenceTimeoutMs?: number
  /** Sentence-end punctuation */
  endPunctuation?: RegExp
}

export interface SemanticFlushEvent {
  text: string
  reason: SemanticFlushReason
  startedAt: number
  endedAt: number
}

const DEFAULT_END_PUNCT = /[。！？.!?]$/
const PUNCT_ONLY = /^[\s。！？.!?,，、；;：:""''「」『』（）()【】\[\]…—\-]+$/

export function isMeaningfulText(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (PUNCT_ONLY.test(t)) return false
  // Must contain at least one letter / digit / CJK
  return /[\p{L}\p{N}\u4e00-\u9fff]/u.test(t)
}

export class SemanticTextBuffer {
  private currentSentenceBuffer = ''
  private sentenceStartTime: number | null = null
  private lastAppendTime: number | null = null
  private maxDurationSec: number
  private silenceTimeoutMs: number
  private endPunctuation: RegExp
  private maxTimer: ReturnType<typeof setTimeout> | null = null
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  private onFlush: ((ev: SemanticFlushEvent) => void) | null = null

  constructor(options: SemanticChunkerOptions = {}) {
    this.maxDurationSec = clampDuration(options.maxDurationSec ?? 15)
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? 2000
    this.endPunctuation = options.endPunctuation ?? DEFAULT_END_PUNCT
  }

  setOnFlush(cb: ((ev: SemanticFlushEvent) => void) | null): void {
    this.onFlush = cb
  }

  setMaxDurationSec(sec: number): void {
    this.maxDurationSec = clampDuration(sec)
    this.rescheduleMaxTimer()
  }

  setSilenceTimeoutMs(ms: number): void {
    this.silenceTimeoutMs = Math.max(500, ms)
    this.rescheduleSilenceTimer()
  }

  peek(): string {
    return this.currentSentenceBuffer
  }

  getStartTime(): number | null {
    return this.sentenceStartTime
  }

  /**
   * Append STT fragment. May synchronously emit via onFlush.
   * Empty string → treat as silence hint (may flush if buffer has content).
   */
  push(text: string): SemanticFlushEvent | null {
    const piece = text.trim()

    // Empty inbound → silence cleanup if we already have content
    if (!piece) {
      if (this.currentSentenceBuffer && isMeaningfulText(this.currentSentenceBuffer)) {
        return this.flush('silence')
      }
      return null
    }

    const now = Date.now()
    if (!this.currentSentenceBuffer) {
      this.sentenceStartTime = now
      this.rescheduleMaxTimer()
    }

    this.currentSentenceBuffer = joinText(this.currentSentenceBuffer, piece)
    this.lastAppendTime = now
    this.rescheduleSilenceTimer()

    // Condition A: semantic completeness via end punctuation
    if (this.endPunctuation.test(this.currentSentenceBuffer.trim())) {
      return this.flush('punctuation')
    }

    // Condition B: already over max (in case timer drifted)
    if (
      this.sentenceStartTime != null &&
      now - this.sentenceStartTime >= this.maxDurationSec * 1000
    ) {
      return this.flush('max-duration')
    }

    return null
  }

  /** Force flush (e.g. stop listening / VAD hard boundary) */
  flush(reason: SemanticFlushReason = 'manual'): SemanticFlushEvent | null {
    const raw = this.currentSentenceBuffer
    const startedAt = this.sentenceStartTime ?? Date.now()
    this.clearTimers()
    this.currentSentenceBuffer = ''
    this.sentenceStartTime = null
    this.lastAppendTime = null

    if (!isMeaningfulText(raw)) return null

    const ev: SemanticFlushEvent = {
      text: raw.trim(),
      reason,
      startedAt,
      endedAt: Date.now()
    }
    this.onFlush?.(ev)
    return ev
  }

  reset(): void {
    this.clearTimers()
    this.currentSentenceBuffer = ''
    this.sentenceStartTime = null
    this.lastAppendTime = null
  }

  private rescheduleMaxTimer(): void {
    if (this.maxTimer != null) {
      clearTimeout(this.maxTimer)
      this.maxTimer = null
    }
    if (this.sentenceStartTime == null || !this.currentSentenceBuffer) return

    const elapsed = Date.now() - this.sentenceStartTime
    const remain = Math.max(0, this.maxDurationSec * 1000 - elapsed)
    this.maxTimer = setTimeout(() => {
      this.maxTimer = null
      this.flush('max-duration')
    }, remain)
  }

  private rescheduleSilenceTimer(): void {
    if (this.silenceTimer != null) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }
    if (!this.currentSentenceBuffer) return

    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null
      if (this.currentSentenceBuffer && isMeaningfulText(this.currentSentenceBuffer)) {
        this.flush('silence')
      }
    }, this.silenceTimeoutMs)
  }

  private clearTimers(): void {
    if (this.maxTimer != null) {
      clearTimeout(this.maxTimer)
      this.maxTimer = null
    }
    if (this.silenceTimer != null) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }
  }
}

function joinText(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  // Avoid double spaces; keep CJK tight if no space needed
  const needSpace = /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b)
  return needSpace ? `${a} ${b}` : `${a}${b}`.replace(/\s+/g, ' ').trim()
}

function clampDuration(sec: number): number {
  return Math.min(30, Math.max(5, sec))
}
