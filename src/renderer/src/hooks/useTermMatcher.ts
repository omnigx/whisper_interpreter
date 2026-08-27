import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranslationDirection } from '@shared/types'
import { useAppStore } from '../stores/appStore'
import type {
  TermScanMode,
  TermWorkerInMessage,
  TermWorkerOutMessage
} from '../workers/termMatcherMessages'
import TermMatcherWorker from '../workers/termMatcher.worker.ts?worker'

function toScanMode(direction: TranslationDirection): TermScanMode {
  return direction === 'zh-en' ? 'ZH_EN' : 'EN_ZH'
}

/**
 * CSV glossary ↔ dual Aho-Corasick scanner (EN / ZH trees).
 * Scans STT source only, gated by translation direction to avoid target-side re-hits.
 */
export function useTermMatcher(): {
  importCsvFile: (file: File) => void
  glossaryCount: number
  ready: boolean
  lastError: string | null
} {
  const workerRef = useRef<Worker | null>(null)
  const [glossaryCount, setGlossaryCount] = useState(0)
  const [ready, setReady] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)

  const transcripts = useAppStore((s) => s.transcripts)
  const partialText = useAppStore((s) => s.partialText)
  const translationDirection = useAppStore(
    (s) => s.settings.translationDirection ?? 'en-zh'
  )

  useEffect(() => {
    const worker = new TermMatcherWorker()
    workerRef.current = worker

    worker.onmessage = (ev: MessageEvent<TermWorkerOutMessage>): void => {
      const msg = ev.data
      if (msg.type === 'INIT_DONE') {
        setGlossaryCount(msg.payload.count)
        setReady(true)
        setLastError(null)
        return
      }
      if (msg.type === 'MATCH_RESULT') {
        if (msg.payload.length > 0) {
          useAppStore.getState().upsertCsvMatchedTerms(msg.payload)
        }
        return
      }
      if (msg.type === 'ERROR') {
        setLastError(msg.payload)
      }
    }

    worker.onerror = (err): void => {
      setLastError(err.message || '术语 Worker 异常')
    }

    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [])

  const post = useCallback((msg: TermWorkerInMessage): void => {
    workerRef.current?.postMessage(msg)
  }, [])

  const importCsvFile = useCallback(
    (file: File): void => {
      const reader = new FileReader()
      reader.onload = () => {
        const text = typeof reader.result === 'string' ? reader.result : ''
        setReady(false)
        post({ type: 'INIT_TERMS', payload: text })
      }
      reader.onerror = () => setLastError('读取 CSV 失败')
      reader.readAsText(file, 'UTF-8')
    },
    [post]
  )

  useEffect(() => {
    if (!ready || glossaryCount === 0) return

    // STT source only — never feed LLM translations into the scanner
    const latestFinals = transcripts
      .filter((t) => t.isFinal && t.text.trim())
      .slice(-8)
      .map((t) => t.text)
      .join('\n')
    const text = [latestFinals, partialText].filter(Boolean).join('\n')
    if (!text.trim()) return

    post({
      type: 'SCAN_TEXT',
      payload: {
        text,
        mode: toScanMode(translationDirection)
      }
    })
  }, [transcripts, partialText, translationDirection, ready, glossaryCount, post])

  return { importCsvFile, glossaryCount, ready, lastError }
}
