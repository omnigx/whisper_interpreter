import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createAudioCapture,
  listAudioInputDevices,
  type AudioCaptureHandle,
  type AudioLevelSnapshot
} from '../services/audioCapture'
import type { VadEngine } from '../services/pipeline'
import { createSttClient, type SttClient } from '../services/stt'
import { createLlmClient, type LlmClient } from '../services/llm'
import type { SileroVadHandle } from '../services/pipeline'
import { getActiveLlm, isCloudStt, isFasterWhisperStt, isUtteranceLocalStt, fasterWhisperModelSize } from '@shared/types'
import { useAppStore } from '../stores/appStore'
import { useNetworkMonitor } from './useNetworkMonitor'
import {
  buildTranslateUserContent,
  isEchoRepetition,
  resolveTranslationRoute,
  directionLabel
} from '../services/translationDirection'
import { detectLanguage } from '../utils/detectLanguage'
import { ensureLlmApiKey } from '../services/secureApiKeys'
import { abortPendingTermExtract } from '../utils/termExtractControl'

export function useAudioPipeline(): {
  devices: MediaDeviceInfo[]
  refreshDevices: () => Promise<void>
  inputLevel: number
  pcmRms: number
  framesEmitted: number
  contextSampleRate: number
  vadSegmentCount: number
  vadEngine: VadEngine | null
  startListening: () => Promise<void>
  stopListening: () => void
  restartListening: () => Promise<void>
  setVolumeLive: (v: number) => void
  setGainLive: (g: number) => void
  setMaxSentenceLive: (ms: number) => void
  setDeviceLive: (deviceId: string) => Promise<void>
} {
  const isListening = useAppStore((s) => s.isListening)
  const setListening = useAppStore((s) => s.setListening)
  const setPipelineStatus = useAppStore((s) => s.setPipelineStatus)
  const setSttLinkStatus = useAppStore((s) => s.setSttLinkStatus)
  const setAudio = useAppStore((s) => s.setAudio)
  const setInputLevel = useAppStore((s) => s.setInputLevel)
  const bumpVadSegment = useAppStore((s) => s.bumpVadSegment)
  const upsertTranscript = useAppStore((s) => s.upsertTranscript)
  const setPartialText = useAppStore((s) => s.setPartialText)
  const upsertTranslation = useAppStore((s) => s.upsertTranslation)
  const removeTranslation = useAppStore((s) => s.removeTranslation)
  const degradeToOffline = useAppStore((s) => s.degradeToOffline)
  const inputLevel = useAppStore((s) => s.inputLevel)
  const vadSegmentCount = useAppStore((s) => s.vadSegmentCount)

  const { cloudReachable, network } = useNetworkMonitor()

  const captureRef = useRef<AudioCaptureHandle | null>(null)
  const vadRef = useRef<(SileroVadHandle & { dispose?: () => void }) | null>(null)
  const sttRef = useRef<SttClient | null>(null)
  const llmRef = useRef<LlmClient | null>(null)
  /** Serial translation jobs; aborted jobs can unshift back to the head */
  const translateQueueRef = useRef<Array<{ unit: string; sourceId?: string }>>([])
  const translatingRef = useRef(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  /** When true, AbortError re-queues the interrupted job (model switch) */
  const requeueOnAbortRef = useRef(false)
  const currentTranslationIdRef = useRef<string | null>(null)
  const llmIdentityRef = useRef<string | null>(null)
  /** Recent final source sentences for LLM context */
  const historyRef = useRef<string[]>([])
  /** Prevent overlapping start/restart */
  const startingRef = useRef(false)

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [pcmRms, setPcmRms] = useState(0)
  const [framesEmitted, setFramesEmitted] = useState(0)
  const [contextSampleRate, setContextSampleRate] = useState(16000)
  const [vadEngine, setVadEngine] = useState<VadEngine | null>(null)

  useEffect(() => {
    captureRef.current = createAudioCapture()
    return () => {
      requeueOnAbortRef.current = false
      abortControllerRef.current?.abort()
      translateQueueRef.current = []
      captureRef.current?.stop()
      captureRef.current = null
      sttRef.current?.disconnect()
      vadRef.current?.dispose?.()
    }
  }, [])

  const refreshDevices = useCallback(async () => {
    try {
      const list = await listAudioInputDevices()
      setDevices(list)
    } catch (e) {
      console.warn('enumerate devices failed', e)
    }
  }, [])

  useEffect(() => {
    void refreshDevices()
    const onChange = (): void => {
      void refreshDevices()
    }
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onChange)
  }, [refreshDevices])

  const drainTranslateQueue = useCallback(async (): Promise<void> => {
    if (translatingRef.current) return
    translatingRef.current = true

    while (translateQueueRef.current.length > 0) {
      const job = translateQueueRef.current.shift()!
      const rawCfg = getActiveLlm(useAppStore.getState().settings)
      if (!rawCfg) {
        setPipelineStatus('目标语言翻译已关闭（LLM = N/A）')
        continue
      }
      const llmCfg = await ensureLlmApiKey(rawCfg)

      llmRef.current = createLlmClient(llmCfg)
      const llm = llmRef.current
      const mainMode =
        useAppStore.getState().settings.translationDirection ?? 'en-zh'
      const { detected, actualDirection, reversed, systemPrompt } =
        resolveTranslationRoute(job.unit, mainMode)
      const history = historyRef.current.slice(-8)
      const userContent = buildTranslateUserContent(job.unit, history, actualDirection)

      const id = `tr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      const linkedSourceId = job.sourceId ?? id
      currentTranslationIdRef.current = id

      const ac = new AbortController()
      abortControllerRef.current = ac

      // Local LLM is shared — drop background term-extract so translate wins
      abortPendingTermExtract()

      upsertTranslation({
        id,
        sourceId: linkedSourceId,
        text: '',
        streaming: true,
        timestamp: Date.now(),
        lang: detected,
        direction: actualDirection,
        type: 'translation'
      })
      const routeHint = reversed
        ? `Auto-LID 反向 · ${directionLabel(actualDirection)}`
        : directionLabel(actualDirection)
      setPipelineStatus(
        `翻译中 · ${routeHint} · LID=${detected} → ${llm.label} · ${llmCfg.model}`
      )

      let assembled = ''
      try {
        assembled = await llm.translateStream(
          userContent,
          (chunk) => {
            assembled += chunk
            if (isEchoRepetition(job.unit, assembled)) return
            upsertTranslation({
              id,
              sourceId: linkedSourceId,
              text: assembled,
              streaming: true,
              timestamp: Date.now(),
              lang: detected,
              direction: actualDirection,
              type: 'translation'
            })
          },
          ac.signal,
          { systemPrompt }
        )

        if (ac.signal.aborted) {
          throw new DOMException('Aborted', 'AbortError')
        }

        if (isEchoRepetition(job.unit, assembled)) {
          removeTranslation(id)
          setPipelineStatus('已拦截复读原文的无效译文')
          continue
        }

        upsertTranslation({
          id,
          sourceId: linkedSourceId,
          text: assembled,
          streaming: false,
          timestamp: Date.now(),
          lang: detected,
          direction: actualDirection,
          type: 'translation'
        })
        historyRef.current = [...historyRef.current, job.unit].slice(-20)
        setPipelineStatus(
          `翻译完成 · ${reversed ? '反向 ' : ''}${directionLabel(actualDirection)} · ${llm.label}`
        )
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') {
          removeTranslation(id)
          if (requeueOnAbortRef.current) {
            translateQueueRef.current.unshift(job)
            requeueOnAbortRef.current = false
            setPipelineStatus(
              `翻译已中断 · 改用 ${llmCfg.model} 重新排队`
            )
          }
          continue
        }
        const msg = e instanceof Error ? e.message : String(e)
        upsertTranslation({
          id,
          sourceId: linkedSourceId,
          text: assembled || `[翻译失败] ${msg}`,
          streaming: false,
          timestamp: Date.now(),
          lang: detected,
          direction: actualDirection,
          type: 'translation'
        })
        setPipelineStatus(`翻译失败：${msg}`)

        const settings = useAppStore.getState().settings
        if (
          settings.engine.autoDegrade &&
          !useAppStore.getState().degraded &&
          getActiveLlm(settings)?.tier === 'cloud'
        ) {
          useAppStore.getState().degradeToOffline()
          if (settings.engine.fallbackLlmId !== 'none') {
            translateQueueRef.current.unshift(job)
          }
        }
      } finally {
        currentTranslationIdRef.current = null
        if (abortControllerRef.current === ac) {
          abortControllerRef.current = null
        }
      }
    }

    translatingRef.current = false
  }, [removeTranslation, setPipelineStatus, upsertTranslation])

  // Hot-swap LLM / model: abort in-flight request, re-queue source, show divider
  const activeLlmId = useAppStore((s) => s.settings.engine.activeLlmId)
  const activeLlmModel = useAppStore((s) => getActiveLlm(s.settings)?.model ?? '')

  useEffect(() => {
    const identity = `${activeLlmId}::${activeLlmModel}`
    if (llmIdentityRef.current === null) {
      llmIdentityRef.current = identity
      return
    }
    if (llmIdentityRef.current === identity) return
    llmIdentityRef.current = identity

    const label = activeLlmModel || activeLlmId || '新模型'
    requeueOnAbortRef.current = true
    abortControllerRef.current?.abort()

    upsertTranslation({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sourceId: 'system',
      text: `---- 切换至 ${label} 模型 ----`,
      streaming: false,
      timestamp: Date.now(),
      type: 'system'
    })
    setPipelineStatus(`已切换至 ${label} · 旧翻译请求已中断`)

    // Ensure drain continues for re-queued / pending jobs with the new client
    window.setTimeout(() => {
      void drainTranslateQueue()
    }, 0)
  }, [activeLlmId, activeLlmModel, drainTranslateQueue, setPipelineStatus, upsertTranslation])

  // Keep enqueueTranslate → drain linked after drain exists
  const runTranslate = useCallback(
    (unit: string, sourceId?: string) => {
      if (!unit.trim()) return
      const st = useAppStore.getState().settings
      if (st.engine.activeLlmId === 'none' || !getActiveLlm(st)) return
      translateQueueRef.current.push({ unit, sourceId })
      void drainTranslateQueue()
    },
    [drainTranslateQueue]
  )

  const stopListening = useCallback(() => {
    startingRef.current = false
    requeueOnAbortRef.current = false
    translateQueueRef.current = []
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    translatingRef.current = false
    sttRef.current?.notifyUtteranceEnd?.()
    captureRef.current?.stop()
    sttRef.current?.disconnect()
    sttRef.current = null
    llmRef.current = null
    vadRef.current?.reset()
    vadRef.current?.dispose?.()
    vadRef.current = null
    setPartialText('')
    setListening(false)
    setInputLevel(0)
    setPcmRms(0)
    setVadEngine(null)
    setSttLinkStatus('idle')
    setPipelineStatus('已停止监听')
  }, [setInputLevel, setListening, setPartialText, setPipelineStatus, setSttLinkStatus])

  const startListening = useCallback(async () => {
    const capture = captureRef.current
    if (!capture) {
      setPipelineStatus('音频模块未就绪，请刷新窗口后重试')
      return
    }
    // Recover from stale flags (HMR / aborted start left isListening or startingRef stuck)
    if (startingRef.current) {
      startingRef.current = false
    }
    if (useAppStore.getState().isListening && !sttRef.current) {
      setListening(false)
    }
    if (useAppStore.getState().isListening) return
    startingRef.current = true

    const settings = useAppStore.getState().settings
    const { audio, stt: sttConfig } = settings
    const llmCfg = getActiveLlm(settings)
    useAppStore.setState({ vadSegmentCount: 0, partialText: '' })
    historyRef.current = []
    requeueOnAbortRef.current = false
    translateQueueRef.current = []
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    translatingRef.current = false
    if (llmCfg) {
      llmRef.current = createLlmClient(llmCfg)
    }

    setPipelineStatus('正在加载 Silero-VAD…')

    const utteranceMode = isUtteranceLocalStt(sttConfig.provider)
    const fasterWhisper = isFasterWhisperStt(sttConfig.provider)
    const vadSilenceMs = utteranceMode ? 800 : 300
    const vadMaxMs = utteranceMode
      ? audio.maxSentenceMs
      : Math.min(10000, audio.maxSentenceMs)

    const sttLabel = fasterWhisper
      ? 'Faster-Whisper 整句'
      : utteranceMode
        ? 'SenseVoice 整句'
        : 'Paraformer 流式'

    try {
      const { createSileroVadAsync } = await import('../services/sileroVad')
      const vad = await createSileroVadAsync({
        maxSentenceMs: vadMaxMs,
        redemptionMs: vadSilenceMs,
        onEngine: (engine) => {
          setVadEngine(engine)
          setPipelineStatus(
            engine === 'silero'
              ? `Silero-VAD 已就绪 · 连接 ${sttLabel}…`
              : `能量 VAD 回退 · 连接 ${sttLabel}…`
          )
        },
        onSegment: (seg) => {
          bumpVadSegment()
          const dur = Math.max(0, Math.round(seg.endMs - seg.startMs))
          const count = useAppStore.getState().vadSegmentCount
          const link = useAppStore.getState().sttLinkStatus
          // Don't overwrite disconnect / reconnect banners with VAD chatter
          if (link === 'connected') {
            setPipelineStatus(
              utteranceMode
                ? `VAD #${count} · ${seg.reason} · ${dur}ms → 整句发送`
                : `VAD #${count} · ${seg.reason} · ${dur}ms → is_final`
            )
          }
          sttRef.current?.notifyUtteranceEnd?.()
        }
      })
      vadRef.current = vad

      const client = createSttClient(sttConfig)
      client.onResult = (result) => {
        if (!result.isFinal) {
          setPartialText(result.text)
          return
        }
        setPartialText('')
        const text = result.text.trim()
        if (!text) return
        const lang = detectLanguage(text)
        upsertTranscript({
          id: result.utteranceId,
          text,
          isFinal: true,
          timestamp: Date.now(),
          lang
        })
        runTranslate(text, result.utteranceId)
      }
      client.onSystem = (message) => {
        const tip = message.trim()
        if (!tip) return
        const line = tip.startsWith('----') ? tip : `---- ${tip} ----`
        upsertTranslation({
          id: `sys-stt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          sourceId: 'system',
          text: line,
          streaming: false,
          timestamp: Date.now(),
          type: 'system'
        })
        setPipelineStatus(tip)
      }
      client.onError = (err) => {
        setPipelineStatus(`STT：${err.message}`)
        const st = useAppStore.getState().settings
        if (st.engine.autoDegrade && isCloudStt(st.stt.provider) && !useAppStore.getState().degraded) {
          setPipelineStatus(`STT 云端失败：${err.message} · 可一键降级离线`)
        }
      }
      client.onStatus = (status) => {
        if (status === 'connecting') {
          if (useAppStore.getState().isListening) {
            setSttLinkStatus('reconnecting')
            setPipelineStatus('STT 连接断开 · 正在自动重连…')
          }
          return
        }
        if (status === 'connected') {
          setSttLinkStatus('connected')
          if (useAppStore.getState().isListening) {
            setPipelineStatus(`STT 已连接 · ${sttLabel}听写中`)
          }
          return
        }
        if (status === 'disconnected') {
          if (useAppStore.getState().isListening) {
            setSttLinkStatus('disconnected')
            setPipelineStatus(
              fasterWhisper
                ? 'Faster-Whisper / STT 连接已断开 · 正在尝试重连…'
                : 'SenseVoice / STT 连接已断开 · 正在尝试重连…'
            )
          } else {
            setSttLinkStatus('idle')
          }
          return
        }
        if (status === 'error') {
          setSttLinkStatus('disconnected')
          setPipelineStatus(
            fasterWhisper
              ? 'STT 连接错误 · 请确认 Faster-Whisper 在 ws://127.0.0.1:8767 运行'
              : 'STT 连接错误 · 请检查 SenseVoice 服务后重新开始听写'
          )
          return
        }
        // Chinese status strings from connect()
        if (typeof status === 'string' && status.length > 0) {
          setPipelineStatus(status)
        }
      }

      await client.connect()
      setSttLinkStatus('connected')
      if (client.mode === 'stream') {
        client.configure?.({
          maxUtteranceMs: vadMaxMs,
          silenceHoldMs: vadSilenceMs
        })
      }
      sttRef.current = client

      await capture.start({
        volume: audio.volume,
        gain: audio.gain,
        deviceId: audio.deviceId || undefined,
        onPcm: (packet) => {
          vadRef.current?.pushPcm(packet)
          sttRef.current?.sendPcm(packet)
        },
        onLevel: (snap: AudioLevelSnapshot) => {
          setInputLevel(snap.inputLevel)
          setPcmRms(snap.pcmRms)
          setFramesEmitted(snap.framesEmitted)
          setContextSampleRate(snap.contextSampleRate)
        },
        onError: (err) => {
          setPipelineStatus(`麦克风错误：${err.message}`)
          startingRef.current = false
          setListening(false)
        }
      })

      setListening(true)
      startingRef.current = false
      const engineLabel = vad.engine === 'silero' ? 'Silero' : 'Energy'
      const llmLabel = llmCfg?.label ?? 'LLM?'
      setPipelineStatus(
        `监听中 · ${engineLabel}-VAD(${vadSilenceMs}ms) → ${sttLabel} → ${llmLabel}`
      )
      void refreshDevices()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      capture.stop()
      sttRef.current?.disconnect()
      sttRef.current = null
      vadRef.current?.dispose?.()
      vadRef.current = null
      startingRef.current = false
      setListening(false)
      setSttLinkStatus('idle')
      setPipelineStatus(`无法启动：${msg}`)
    }
  }, [
    bumpVadSegment,
    refreshDevices,
    runTranslate,
    setInputLevel,
    setListening,
    setPartialText,
    setPipelineStatus,
    setSttLinkStatus,
    upsertTranscript,
    upsertTranslation
  ])

  const restartListening = useCallback(async () => {
    stopListening()
    await new Promise((r) => setTimeout(r, 200))
    await startListening()
  }, [startListening, stopListening])

  const restartListeningRef = useRef(restartListening)
  restartListeningRef.current = restartListening

  // Restart on STT change; Faster-Whisper medium ↔ large-v3 hot-swaps without reconnect
  const sttProvider = useAppStore((s) => s.settings.stt.provider)
  const sttUrl = useAppStore((s) => s.settings.stt.websocketUrl)
  const prevSttRef = useRef({ provider: sttProvider, url: sttUrl })
  useEffect(() => {
    const prev = prevSttRef.current
    const changed = prev.provider !== sttProvider || prev.url !== sttUrl
    prevSttRef.current = { provider: sttProvider, url: sttUrl }
    if (!changed) return
    if (!useAppStore.getState().isListening) return

    const prevFw = fasterWhisperModelSize(prev.provider)
    const nextFw = fasterWhisperModelSize(sttProvider)

    // Stay on the same 8767 socket when only the FW model size changes
    if (prevFw != null && nextFw != null) {
      if (prevFw === nextFw) {
        setPipelineStatus(`STT 已是 ${nextFw} · 无需重连`)
        return
      }
      if (sttRef.current?.switchFasterWhisperModel) {
        sttRef.current.switchFasterWhisperModel(nextFw)
        setPipelineStatus(`STT 热切换 → ${nextFw}…`)
        upsertTranslation({
          id: `sys-stt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          sourceId: 'system',
          text: `---- STT引擎已热切换至 ${nextFw} ----`,
          streaming: false,
          timestamp: Date.now(),
          type: 'system'
        })
        return
      }
    }

    setPartialText('')
    setPipelineStatus('STT 引擎已切换 · 正在重连…')
    void restartListeningRef.current()
  }, [setPartialText, setPipelineStatus, sttProvider, sttUrl, upsertTranslation])

  // Auto-degrade when network/cloud drops during session
  useEffect(() => {
    const settings = useAppStore.getState().settings
    if (!isListening || !settings.engine.autoDegrade || useAppStore.getState().degraded) {
      return
    }
    if (!isCloudStt(settings.stt.provider) && getActiveLlm(settings)?.tier !== 'cloud') {
      return
    }
    if (network === 'offline' || cloudReachable === false) {
      setPipelineStatus('检测到云端不可达 · 自动降级中…')
      degradeToOffline()
      void restartListening()
    }
  }, [
    cloudReachable,
    degradeToOffline,
    isListening,
    network,
    restartListening,
    setPipelineStatus
  ])

  const setVolumeLive = useCallback(
    (v: number) => {
      setAudio({ volume: v })
      captureRef.current?.setVolume(v)
    },
    [setAudio]
  )

  const setGainLive = useCallback(
    (g: number) => {
      setAudio({ gain: g })
      captureRef.current?.setGain(g)
    },
    [setAudio]
  )

  const setMaxSentenceLive = useCallback(
    (ms: number) => {
      const clamped = Math.min(30000, Math.max(5000, ms))
      setAudio({ maxSentenceMs: clamped })
      vadRef.current?.setMaxSentenceMs(clamped)
      const utterance = isUtteranceLocalStt(
        useAppStore.getState().settings.stt.provider
      )
      sttRef.current?.configure?.({
        maxUtteranceMs: utterance ? clamped : Math.min(10000, clamped),
        silenceHoldMs: utterance ? 800 : 300
      })
    },
    [setAudio]
  )

  const setDeviceLive = useCallback(
    async (deviceId: string) => {
      setAudio({ deviceId })
      if (isListening) {
        await captureRef.current?.setDeviceId(deviceId || undefined)
      }
    },
    [isListening, setAudio]
  )

  return {
    devices,
    refreshDevices,
    inputLevel,
    pcmRms,
    framesEmitted,
    contextSampleRate,
    vadSegmentCount,
    vadEngine,
    startListening,
    stopListening,
    restartListening,
    setVolumeLive,
    setGainLive,
    setMaxSentenceLive,
    setDeviceLive
  }
}
