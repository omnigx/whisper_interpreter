import { useCallback, useEffect, useRef, useState } from 'react'
import { getActiveLlm, type LlmEndpointConfig } from '@shared/types'
import { createLlmClient } from '../services/llm'
import { useAppStore } from '../stores/appStore'

export type NetworkState = 'online' | 'offline' | 'checking'

export function useNetworkMonitor(): {
  network: NetworkState
  cloudReachable: boolean | null
  localLlmReachable: boolean | null
  refreshProbes: () => Promise<void>
} {
  const [network, setNetwork] = useState<NetworkState>(
    typeof navigator !== 'undefined' && navigator.onLine ? 'online' : 'offline'
  )
  const [cloudReachable, setCloudReachable] = useState<boolean | null>(null)
  const [localLlmReachable, setLocalLlmReachable] = useState<boolean | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshProbes = useCallback(async () => {
    const settings = useAppStore.getState().settings
    const active = getActiveLlm(settings)
    const fallback = settings.llms.find((l) => l.id === settings.engine.fallbackLlmId)

    const cloudCfg =
      active?.tier === 'cloud'
        ? active
        : settings.llms.find((l) => l.tier === 'cloud')
    const localCfg =
      fallback?.tier === 'local'
        ? fallback
        : settings.llms.find((l) => l.tier === 'local')

    const probes: Array<Promise<void>> = []

    if (cloudCfg) {
      probes.push(
        createLlmClient(cloudCfg)
          .ping()
          .then((ok) => setCloudReachable(ok))
          .catch(() => setCloudReachable(false))
      )
    } else {
      setCloudReachable(null)
    }

    if (localCfg) {
      probes.push(
        createLlmClient(localCfg)
          .ping()
          .then((ok) => setLocalLlmReachable(ok))
          .catch(() => setLocalLlmReachable(false))
      )
    } else {
      setLocalLlmReachable(null)
    }

    await Promise.all(probes)
  }, [])

  useEffect(() => {
    const onOnline = (): void => {
      setNetwork('online')
      void refreshProbes()
    }
    const onOffline = (): void => {
      setNetwork('offline')
      setCloudReachable(false)
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    void refreshProbes()
    timerRef.current = setInterval(() => void refreshProbes(), 20000)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [refreshProbes])

  return { network, cloudReachable, localLlmReachable, refreshProbes }
}

export function resolveLlmForTranslate(): LlmEndpointConfig | undefined {
  return getActiveLlm(useAppStore.getState().settings)
}
