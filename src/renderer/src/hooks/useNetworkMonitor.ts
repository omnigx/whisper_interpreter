import { useSyncExternalStore } from 'react'
import { getActiveLlm, type LlmEndpointConfig } from '@shared/types'
import { createLlmClient } from '../services/llm'
import { useAppStore } from '../stores/appStore'

export type NetworkState = 'online' | 'offline' | 'checking'

interface MonitorState {
  network: NetworkState
  cloudReachable: boolean | null
  localLlmReachable: boolean | null
}

/**
 * Module-level singleton: the hook is mounted in several components
 * (pipeline / footer / engine bar) — one probe timer for the whole window,
 * not one per subscriber.
 */
let state: MonitorState = {
  network:
    typeof navigator !== 'undefined' && navigator.onLine ? 'online' : 'offline',
  cloudReachable: null,
  localLlmReachable: null
}

const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let windowHooksAttached = false

function emit(patch: Partial<MonitorState>): void {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

async function refreshProbes(): Promise<void> {
  const settings = useAppStore.getState().settings
  const active = getActiveLlm(settings)
  const fallback = settings.llms.find((l) => l.id === settings.engine.fallbackLlmId)

  const cloudCfg =
    active?.tier === 'cloud' ? active : settings.llms.find((l) => l.tier === 'cloud')
  const localCfg =
    fallback?.tier === 'local'
      ? fallback
      : settings.llms.find((l) => l.tier === 'local')

  const probes: Array<Promise<void>> = []

  if (cloudCfg) {
    probes.push(
      createLlmClient(cloudCfg)
        .ping()
        .then((ok) => emit({ cloudReachable: ok }))
        .catch(() => emit({ cloudReachable: false }))
    )
  } else {
    emit({ cloudReachable: null })
  }

  if (localCfg) {
    probes.push(
      createLlmClient(localCfg)
        .ping()
        .then((ok) => emit({ localLlmReachable: ok }))
        .catch(() => emit({ localLlmReachable: false }))
    )
  } else {
    emit({ localLlmReachable: null })
  }

  await Promise.all(probes)
}

function attachWindowHooks(): void {
  if (windowHooksAttached || typeof window === 'undefined') return
  windowHooksAttached = true
  window.addEventListener('online', () => {
    emit({ network: 'online' })
    void refreshProbes()
  })
  window.addEventListener('offline', () => {
    emit({ network: 'offline', cloudReachable: false })
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  attachWindowHooks()
  if (listeners.size === 1) {
    void refreshProbes()
    timer = setInterval(() => void refreshProbes(), 20000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

function getSnapshot(): MonitorState {
  return state
}

export function useNetworkMonitor(): {
  network: NetworkState
  cloudReachable: boolean | null
  localLlmReachable: boolean | null
  refreshProbes: () => Promise<void>
} {
  const snap = useSyncExternalStore(subscribe, getSnapshot)
  return { ...snap, refreshProbes }
}

export function resolveLlmForTranslate(): LlmEndpointConfig | undefined {
  return getActiveLlm(useAppStore.getState().settings)
}
