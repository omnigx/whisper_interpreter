import { useCallback, useEffect, useState } from 'react'
import type { SubtitleMirrorState } from '@shared/subtitleSync'
import {
  DEFAULT_CHINESE_FONT,
  DEFAULT_WESTERN_FONT
} from '@shared/subtitleSync'
import { FullSizeMode } from '../pages/FullSizeMode'
import { SubtitleView } from '../pages/SubtitleView'
import { useSubtitleBroadcast } from '../hooks/useSubtitleBroadcast'
import { bootEngineConfig } from '../services/enginePersistence'
import { useAppStore } from '../stores/appStore'
import { localSttLauncherKey } from '@shared/types'

function isSubtitleHash(): boolean {
  const h = window.location.hash.replace(/^#/, '')
  return h === '/subtitle' || h === 'subtitle'
}

const EMPTY_MIRROR: SubtitleMirrorState = {
  partialText: '',
  transcripts: [],
  translations: [],
  subtitleDisplay: { displayMode: 'count', countLimit: 3, timeLimit: 15 },
  isListening: false,
  chineseFont: DEFAULT_CHINESE_FONT,
  westernFont: DEFAULT_WESTERN_FONT
}

/** Satellite window: dumb SubtitleView fed only via IPC. */
function SubtitleSatelliteApp(): React.JSX.Element {
  const [mirror, setMirror] = useState<SubtitleMirrorState>(EMPTY_MIRROR)

  useEffect(() => {
    const unsub = window.whisperApi?.onSubtitleState?.((state) => {
      setMirror(state)
    })
    return () => unsub?.()
  }, [])

  const onClose = useCallback(() => {
    void window.whisperApi?.toggleSubtitleWindow?.(false)
  }, [])

  return (
    <div className="h-full w-full bg-transparent">
      <SubtitleView state={mirror} onClose={onClose} />
    </div>
  )
}

/** Primary window: full UI + broadcast to subtitle satellite. */
function MainApp(): React.JSX.Element {
  const [subtitleOpen, setSubtitleOpen] = useState(false)

  // Only mirror snapshots while the satellite window actually exists —
  // otherwise every store update pays a full structured-clone IPC for nothing.
  useSubtitleBroadcast(subtitleOpen)

  useEffect(() => {
    void bootEngineConfig().then(() => {
      // Warm up the default local engine right after settings restore —
      // model loading takes 10–40 s, so start it before the user clicks 听写.
      const key = localSttLauncherKey(useAppStore.getState().settings.stt.provider)
      if (key) void window.whisperApi?.ensureSttEngine?.(key, 120000)
    })
  }, [])

  useEffect(() => {
    void window.whisperApi?.isSubtitleWindowOpen?.().then((open) => {
      if (typeof open === 'boolean') setSubtitleOpen(open)
    })
    const unsubState = window.whisperApi?.onSubtitleWindowState?.((open) => {
      setSubtitleOpen(open)
    })
    const unsubClosed = window.whisperApi?.onSubtitleWindowClosed?.(() => {
      setSubtitleOpen(false)
    })
    return () => {
      unsubState?.()
      unsubClosed?.()
    }
  }, [])

  const toggleSubtitle = useCallback(async () => {
    const next = !subtitleOpen
    setSubtitleOpen(next)
    await window.whisperApi?.toggleSubtitleWindow?.(next)
  }, [subtitleOpen])

  return (
    <FullSizeMode
      subtitleOpen={subtitleOpen}
      onToggleSubtitle={() => void toggleSubtitle()}
    />
  )
}

/**
 * Hash `#/subtitle` → satellite display only.
 * Default → main interpreter UI (owns mic / STT / LLM).
 */
export function AppShell(): React.JSX.Element {
  const [subtitleRoute] = useState(() => isSubtitleHash())

  useEffect(() => {
    if (subtitleRoute) {
      document.body.classList.add('subtitle-body')
      document.title = 'Whisper Interpreter — Subtitle'
    }
  }, [subtitleRoute])

  if (subtitleRoute) return <SubtitleSatelliteApp />
  return <MainApp />
}
