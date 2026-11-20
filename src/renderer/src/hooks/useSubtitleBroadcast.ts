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
    westernFont: display.westernFont,
    audioTunables: {
      gain: s.settings.audio.gain,
      maxSentenceMs: s.settings.audio.maxSentenceMs,
      vadSilenceMs: s.settings.audio.vadSilenceMs
    }
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
  const audioTunables = useAppStore(
    (s) =>
      `${s.settings.audio.gain}|${s.settings.audio.maxSentenceMs}|${s.settings.audio.vadSilenceMs}`
  )

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
    westernFont,
    audioTunables
  ])

  useEffect(() => {
    if (!enabled) return
    const unsubOpen = window.whisperApi?.onSubtitleWindowOpened?.(() => push())
    const unsubDocked = window.whisperApi?.onDockedWindowOpened?.(() => push())
    return () => {
      unsubOpen?.()
      unsubDocked?.()
    }
  }, [enabled])
}
