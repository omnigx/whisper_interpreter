import { useEffect } from 'react'
import type { SubtitleMirrorState } from '@shared/subtitleSync'
import { useAppStore } from '../stores/appStore'

function snapshotFromStore(): SubtitleMirrorState {
  const s = useAppStore.getState()
  const display = s.settings.display
  return {
    partialText: s.partialText,
    transcripts: s.transcripts,
    translations: s.translations,
    subtitleDisplay: s.settings.subtitleDisplay ?? {
      displayMode: 'count',
      countLimit: 3,
      timeLimit: 15
    },
    isListening: s.isListening,
    pipelineStatus: s.pipelineStatus,
    chineseFont: display.chineseFont,
    westernFont: display.westernFont
  }
}

function push(): void {
  window.whisperApi?.pushSubtitleState?.(snapshotFromStore())
}

/**
 * Main-window only: broadcast store snapshots to the subtitle satellite window.
 * Subtitle must never run STT / mic / LLM — it only renders this mirror.
 */
export function useSubtitleBroadcast(enabled: boolean): void {
  const partialText = useAppStore((s) => s.partialText)
  const transcripts = useAppStore((s) => s.transcripts)
  const translations = useAppStore((s) => s.translations)
  const subtitleDisplay = useAppStore((s) => s.settings.subtitleDisplay)
  const isListening = useAppStore((s) => s.isListening)
  const pipelineStatus = useAppStore((s) => s.pipelineStatus)
  const chineseFont = useAppStore((s) => s.settings.display.chineseFont)
  const westernFont = useAppStore((s) => s.settings.display.westernFont)

  useEffect(() => {
    if (!enabled) return
    push()
  }, [
    enabled,
    partialText,
    transcripts,
    translations,
    subtitleDisplay,
    isListening,
    pipelineStatus,
    chineseFont,
    westernFont
  ])

  useEffect(() => {
    if (!enabled) return
    const unsubOpen = window.whisperApi?.onSubtitleWindowOpened?.(() => push())
    return () => unsubOpen?.()
  }, [enabled])
}
