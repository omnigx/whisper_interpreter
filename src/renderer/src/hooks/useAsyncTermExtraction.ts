import { useEffect, useRef } from 'react'
import { getActiveLlm } from '@shared/types'
import { createLlmClient } from '../services/llm'
import { ensureLlmApiKey } from '../services/secureApiKeys'
import { useAppStore } from '../stores/appStore'
import { pairToTermTexts } from '../utils/termHelpers'
import {
  abortPendingTermExtract,
  registerTermExtractAbort
} from '../utils/termExtractControl'

/** Speaker pause / translate idle before extracting (3–5s). */
const IDLE_MS = 4000

type AbortReason = 'translate' | 'disable' | null

/**
 * Background LLM terminology extraction — idle-triggered, gated by
 * `isLlmExtractionEnabled` (default off). CSV matcher is independent.
 */
export function useAsyncTermExtraction(): void {
  const textBufferRef = useRef('')
  const sentenceCountRef = useRef(0)
  const bufferedPairIdsRef = useRef(new Set<string>())
  const isExtractingTermsRef = useRef(false)
  /** Dedicated AbortController for LLM term-extract fetch */
  const llmExtractAbortControllerRef = useRef<AbortController | null>(null)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortReasonRef = useRef<AbortReason>(null)

  const isLlmExtractionEnabled = useAppStore((s) => s.isLlmExtractionEnabled)
  const transcripts = useAppStore((s) => s.transcripts)
  const translations = useAppStore((s) => s.translations)
  const isListening = useAppStore((s) => s.isListening)

  const clearIdleTimer = (): void => {
    if (idleTimerRef.current != null) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
  }

  const clearBuffer = (): void => {
    textBufferRef.current = ''
    sentenceCountRef.current = 0
  }

  /** Hard stop: abort in-flight fetch, unlock, drop buffer. */
  const shutdownExtraction = (reason: AbortReason): void => {
    clearIdleTimer()
    abortReasonRef.current = reason
    llmExtractAbortControllerRef.current?.abort()
    llmExtractAbortControllerRef.current = null
    isExtractingTermsRef.current = false
    clearBuffer()
    // Skip already-seen STT so re-enable only picks up new sentences
    if (reason === 'disable') {
      bufferedPairIdsRef.current = new Set(
        useAppStore.getState().transcripts.map((t) => t.id)
      )
    }
  }

  const abortExtraction = useRef((reason: AbortReason = 'translate'): void => {
    /* assigned below */
  })

  abortExtraction.current = (reason: AbortReason = 'translate'): void => {
    if (!isExtractingTermsRef.current && !llmExtractAbortControllerRef.current) {
      return
    }
    abortReasonRef.current = reason
    llmExtractAbortControllerRef.current?.abort()
    llmExtractAbortControllerRef.current = null
    // isExtractingTerms cleared in Promise finally (or immediately on disable)
  }

  useEffect(() => {
    registerTermExtractAbort(() => abortExtraction.current('translate'))
    return () => registerTermExtractAbort(null)
  }, [])

  // Toggle off → immediate abort + clear buffer
  useEffect(() => {
    if (isLlmExtractionEnabled) return
    shutdownExtraction('disable')
  }, [isLlmExtractionEnabled])

  const tryFlush = useRef((): void => {
    /* assigned below */
  })

  tryFlush.current = (): void => {
    // Guard first: never fetch / never clear buffer when AI extract is off
    if (!useAppStore.getState().isLlmExtractionEnabled) return
    if (isExtractingTermsRef.current) return
    if (sentenceCountRef.current < 1) return

    const snapshot = textBufferRef.current.trim()
    if (!snapshot) {
      sentenceCountRef.current = 0
      return
    }

    clearBuffer()
    isExtractingTermsRef.current = true
    abortReasonRef.current = null

    const settings = useAppStore.getState().settings
    const cfg = getActiveLlm(settings)
    if (!cfg) {
      isExtractingTermsRef.current = false
      return
    }

    llmExtractAbortControllerRef.current?.abort()
    const ac = new AbortController()
    llmExtractAbortControllerRef.current = ac

    void (async () => {
      try {
        const ready = await ensureLlmApiKey(cfg)
        const llm = createLlmClient(ready)
        const rawHits = await llm.extractTerms(snapshot, ac.signal)
        if (ac.signal.aborted) return
        if (!useAppStore.getState().isLlmExtractionEnabled) return

        if (!rawHits.length) {
          console.info('[term-extract] 本次无术语或解析为空')
          return
        }

        const normalized = rawHits.map((h) =>
          pairToTermTexts(h.foreignText, h.chineseText)
        )
        useAppStore.getState().mergeLlmExtractedTerms(normalized)
        console.info('[term-extract] 已合并术语', normalized.length)
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') {
          if (abortReasonRef.current === 'disable') {
            console.info('AI 术语提取已手动关闭，请求已丢弃')
          } else {
            console.info('[term-extract] 已中止（为翻译让路）')
          }
          return
        }
        console.error('[term-extract] 请求失败', e)
      } finally {
        if (llmExtractAbortControllerRef.current === ac) {
          llmExtractAbortControllerRef.current = null
        }
        isExtractingTermsRef.current = false
      }
    })()
  }

  const scheduleIdleFlush = (): void => {
    clearIdleTimer()
    if (!useAppStore.getState().isLlmExtractionEnabled) return
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null
      tryFlush.current()
    }, IDLE_MS)
  }

  // Collect bilingual finals only while AI extract is on
  useEffect(() => {
    if (!isLlmExtractionEnabled) return

    const translating = translations.some(
      (tr) => tr.type !== 'system' && tr.streaming
    )
    if (translating) {
      abortExtraction.current('translate')
    }

    for (const t of transcripts) {
      if (!t.isFinal || !t.text.trim()) continue
      if (bufferedPairIdsRef.current.has(t.id)) continue

      const linked = translations.find(
        (tr) =>
          tr.sourceId === t.id &&
          tr.type !== 'system' &&
          !tr.streaming &&
          tr.text.trim() &&
          !tr.text.startsWith('[翻译失败]')
      )
      if (!linked) continue

      bufferedPairIdsRef.current.add(t.id)
      const chunk = `[STT] ${t.text}\n[TR] ${linked.text}`
      textBufferRef.current = textBufferRef.current
        ? `${textBufferRef.current}\n\n${chunk}`
        : chunk
      sentenceCountRef.current += 1
    }

    if (bufferedPairIdsRef.current.size > 200) {
      bufferedPairIdsRef.current = new Set(transcripts.slice(-80).map((x) => x.id))
    }

    scheduleIdleFlush()
  }, [isLlmExtractionEnabled, transcripts, translations])

  useEffect(() => {
    if (!isLlmExtractionEnabled || isListening) return
    clearIdleTimer()
    if (isExtractingTermsRef.current) return
    if (sentenceCountRef.current < 1 || !textBufferRef.current.trim()) return

    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null
      tryFlush.current()
    }, 800)
  }, [isLlmExtractionEnabled, isListening])

  useEffect(() => {
    return () => {
      clearIdleTimer()
      abortPendingTermExtract()
      llmExtractAbortControllerRef.current?.abort()
      registerTermExtractAbort(null)
    }
  }, [])
}
