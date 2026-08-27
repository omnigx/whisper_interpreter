import { useCallback, useEffect, useRef, useState } from 'react'
import {
  SemanticTextBuffer,
  type SemanticFlushEvent,
  type SemanticFlushReason
} from '../services/semanticChunker'
import { createLlmClient, type LlmClient } from '../services/llm'
import { getActiveLlm } from '@shared/types'
import { useAppStore } from '../stores/appStore'
import {
  buildTranslateUserContent,
  directionLabel,
  resolveTranslationRoute
} from '../services/translationDirection'

export interface UseSemanticChunkerOptions {
  /** Override max duration seconds; default from settings.audio.maxSentenceMs */
  maxDurationSec?: number
  /** Silence idle flush (ms), default 2000 */
  silenceTimeoutMs?: number
  /** When true, automatically translate flushed sentences via active LLM */
  autoTranslate?: boolean
  /** Extra callback when a semantic unit is ready */
  onSentence?: (ev: SemanticFlushEvent) => void
}

export interface UseSemanticChunkerResult {
  /** Feed STT text fragment (plain string from SenseVoice / other STT) */
  pushSttText: (text: string) => void
  /** Force flush remaining buffer */
  flush: (reason?: SemanticFlushReason) => void
  reset: () => void
  /** Live buffer preview */
  bufferPreview: string
  lastFlushReason: SemanticFlushReason | null
  setMaxDurationSec: (sec: number) => void
}

/**
 * STT → semantic completeness gate → optional Ollama/LLM streaming translation.
 *
 * Triggers:
 *  A) End punctuation /[。！？.!?]$/
 *  B) maxDuration timeout (settings 5–30s)
 *  C) 2s silence / empty STT fragment with non-empty buffer
 */
export function useSemanticChunker(
  options: UseSemanticChunkerOptions = {}
): UseSemanticChunkerResult {
  const {
    maxDurationSec: maxDurationOverride,
    silenceTimeoutMs = 2000,
    autoTranslate = true,
    onSentence
  } = options

  const maxSentenceMs = useAppStore((s) => s.settings.audio.maxSentenceMs)
  const upsertTranslation = useAppStore((s) => s.upsertTranslation)
  const setPipelineStatus = useAppStore((s) => s.setPipelineStatus)

  const maxDurationSec =
    maxDurationOverride ?? Math.round(maxSentenceMs / 1000)

  const [bufferPreview, setBufferPreview] = useState('')
  const [lastFlushReason, setLastFlushReason] = useState<SemanticFlushReason | null>(
    null
  )

  const bufferRef = useRef<SemanticTextBuffer | null>(null)
  const llmRef = useRef<LlmClient | null>(null)
  const translateChainRef = useRef<Promise<void>>(Promise.resolve())
  const abortRef = useRef<AbortController | null>(null)
  const onSentenceRef = useRef(onSentence)
  onSentenceRef.current = onSentence

  const runTranslate = useCallback(
    (unit: string, reason: SemanticFlushReason) => {
      if (!autoTranslate) return

      const cfg = getActiveLlm(useAppStore.getState().settings)
      if (!cfg) {
        setPipelineStatus('无可用 LLM，请在引擎设置中配置 Ollama / 云端模型')
        return
      }
      // Recreate each time so model/baseUrl changes apply immediately
      llmRef.current = createLlmClient(cfg)
      const llm = llmRef.current

      const mainMode =
        useAppStore.getState().settings.translationDirection ?? 'en-zh'
      const { detected, actualDirection, reversed, systemPrompt } =
        resolveTranslationRoute(unit, mainMode)
      const userContent = buildTranslateUserContent(unit, [], actualDirection)

      translateChainRef.current = translateChainRef.current.then(async () => {
        const id = `tr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        upsertTranslation({
          id,
          sourceId: id,
          text: '',
          streaming: true,
          timestamp: Date.now(),
          lang: detected,
          direction: actualDirection
        })
        const routeHint = reversed
          ? `Auto-LID 反向 · ${directionLabel(actualDirection)}`
          : directionLabel(actualDirection)
        setPipelineStatus(
          `翻译中 · ${reason} · ${routeHint} · LID=${detected} · ${llm.label} · ${cfg.model}`
        )

        let assembled = ''
        try {
          assembled = await llm.translateStream(
            userContent,
            (chunk) => {
              assembled += chunk
              upsertTranslation({
                id,
                sourceId: id,
                text: assembled,
                streaming: true,
                timestamp: Date.now(),
                lang: detected,
                direction: actualDirection
              })
            },
            abortRef.current?.signal,
            { systemPrompt }
          )
          upsertTranslation({
            id,
            sourceId: id,
            text: assembled,
            streaming: false,
            timestamp: Date.now(),
            lang: detected,
            direction: actualDirection
          })
          setPipelineStatus(`翻译完成 · ${reason} · ${directionLabel(actualDirection)}`)
        } catch (e) {
          if ((e as Error)?.name === 'AbortError') return
          const msg = e instanceof Error ? e.message : String(e)
          upsertTranslation({
            id,
            sourceId: id,
            text: assembled || `[翻译失败] ${msg}`,
            streaming: false,
            timestamp: Date.now(),
            lang: detected,
            direction: actualDirection
          })
          setPipelineStatus(`翻译失败：${msg}`)
        }
      })
    },
    [autoTranslate, setPipelineStatus, upsertTranslation]
  )

  const handleFlush = useCallback(
    (ev: SemanticFlushEvent) => {
      setLastFlushReason(ev.reason)
      setBufferPreview('')
      setPipelineStatus(
        `语义切分 · ${ev.reason} · ${ev.text.slice(0, 24)}${ev.text.length > 24 ? '…' : ''}`
      )
      onSentenceRef.current?.(ev)
      runTranslate(ev.text, ev.reason)
    },
    [runTranslate, setPipelineStatus]
  )

  // (Re)create buffer when duration / silence options change
  useEffect(() => {
    const buf = new SemanticTextBuffer({
      maxDurationSec,
      silenceTimeoutMs
    })
    buf.setOnFlush(handleFlush)
    bufferRef.current = buf
    abortRef.current = new AbortController()

    return () => {
      buf.reset()
      abortRef.current?.abort()
      bufferRef.current = null
    }
  }, [handleFlush, maxDurationSec, silenceTimeoutMs])

  const pushSttText = useCallback((text: string) => {
    const buf = bufferRef.current
    if (!buf) return
    buf.push(text)
    setBufferPreview(buf.peek())
  }, [])

  const flush = useCallback((reason: SemanticFlushReason = 'manual') => {
    bufferRef.current?.flush(reason)
    setBufferPreview('')
  }, [])

  const reset = useCallback(() => {
    bufferRef.current?.reset()
    setBufferPreview('')
    setLastFlushReason(null)
    llmRef.current = null
    translateChainRef.current = Promise.resolve()
  }, [])

  const setMaxDurationSec = useCallback((sec: number) => {
    bufferRef.current?.setMaxDurationSec(sec)
  }, [])

  return {
    pushSttText,
    flush,
    reset,
    bufferPreview,
    lastFlushReason,
    setMaxDurationSec
  }
}
