import type { SttPartialResult } from './pipeline'

export interface ContextBufferHandle {
  /** Feed STT partial/final; may return a semantic unit ready for LLM */
  push: (result: SttPartialResult) => string | null
  /** Force flush on VAD boundary / max-sentence */
  flush: () => string | null
  /** Soft boundary: prefer flush if buffer has content */
  onVadBoundary: () => string | null
  reset: () => void
  peek: () => string
}

/**
 * Reassemble streaming STT into semantic chunks for LLM translation.
 * Rules: punctuation end, length cap, or VAD boundary with enough content.
 */
export function createContextBuffer(options?: {
  maxChars?: number
  minCharsOnVad?: number
}): ContextBufferHandle {
  const maxChars = options?.maxChars ?? 120
  const minCharsOnVad = options?.minCharsOnVad ?? 8
  let buf = ''
  let lastPartial = ''

  const emit = (): string | null => {
    const out = buf.trim()
    buf = ''
    lastPartial = ''
    return out || null
  }

  return {
    push(result) {
      if (!result.isFinal) {
        lastPartial = result.text
        return null
      }
      // commit final
      lastPartial = ''
      buf = `${buf} ${result.text}`.trim()
      if (/[.!?。！？；;]$/.test(buf) || buf.length >= maxChars) {
        return emit()
      }
      return null
    },
    flush: emit,
    onVadBoundary() {
      // Prefer finalized buffer; if only partial, don't invent text
      if (buf.trim().length >= minCharsOnVad) {
        return emit()
      }
      return null
    },
    reset() {
      buf = ''
      lastPartial = ''
    },
    peek() {
      return (buf || lastPartial).trim()
    }
  }
}
