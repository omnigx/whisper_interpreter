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

/** 停靠变体标记（?docked=1）：不透明底 + 关闭走 docked 通道 */
function isDockedVariant(): boolean {
  return new URLSearchParams(window.location.search).get('docked') === '1'
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
  const [docked] = useState(isDockedVariant)

  useEffect(() => {
    const unsub = window.whisperApi?.onSubtitleState?.((state) => {
      setMirror(state)
    })
    return () => unsub?.()
  }, [])

  const onClose = useCallback(() => {
    void (docked
      ? window.whisperApi?.toggleDockedWindow?.(false)
      : window.whisperApi?.toggleSubtitleWindow?.(false))
  }, [docked])

  return (
    <div className={`h-full w-full ${docked ? 'bg-[var(--bg-deep)]' : 'bg-transparent'}`}>
      <SubtitleView state={mirror} onClose={onClose} docked={docked} />
    </div>
  )
}

/** Primary window: full UI + broadcast to subtitle satellite. */
function MainApp(): React.JSX.Element {
  const [subtitleOpen, setSubtitleOpen] = useState(false)
  const [dockedOpen, setDockedOpen] = useState(false)

  // Only mirror snapshots while a satellite window actually exists —
  // otherwise every store update pays a full structured-clone IPC for nothing.
  useSubtitleBroadcast(subtitleOpen || dockedOpen)

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

  useEffect(() => {
    void window.whisperApi?.isDockedWindowOpen?.().then((open) => {
      if (typeof open === 'boolean') setDockedOpen(open)
    })
    const unsubState = window.whisperApi?.onDockedWindowState?.((open) => {
      setDockedOpen(open)
    })
    const unsubClosed = window.whisperApi?.onDockedWindowClosed?.(() => {
      setDockedOpen(false)
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

  const toggleDocked = useCallback(async () => {
    const next = !dockedOpen
    setDockedOpen(next)
    await window.whisperApi?.toggleDockedWindow?.(next)
  }, [dockedOpen])

  return (
    <FullSizeMode
      subtitleOpen={subtitleOpen}
      onToggleSubtitle={() => void toggleSubtitle()}
      dockedOpen={dockedOpen}
      onToggleDocked={() => void toggleDocked()}
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
      if (isDockedVariant()) document.body.classList.add('docked-body')
      document.title = 'Whisper Interpreter — Subtitle'
    }
  }, [subtitleRoute])

  if (subtitleRoute) return <SubtitleSatelliteApp />
  return <MainApp />
}
