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
import { getActiveLlm, isCloudStt, isFasterWhisperStt, isUtteranceLocalStt, fasterWhisperModelSize, clampVadSilenceMs, localSttLauncherKey } from '@shared/types'
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
import { createThrottledEmitter } from '../utils/streamingUpdate'
import { logSessionEvent } from '../services/sessionLogger'
import { publishMeter } from '../services/meterBus'
import {
  appendSyncRecordingPcm,
  getLastRecordingFile,
  isSyncRecordingActive,
  startSyncRecording,
  stopSyncRecording
} from '../services/syncRecorder'

export function useAudioPipeline(): {
  devices: MediaDeviceInfo[]
  refreshDevices: () => Promise<void>
  vadSegmentCount: number
  vadEngine: VadEngine | null
  startListening: () => Promise<void>
  stopListening: () => void
  restartListening: () => Promise<void>
  setVolumeLive: (v: number) => void
  setGainLive: (g: number) => void
  setMaxSentenceLive: (ms: number) => void
  setSilenceLive: (ms: number) => void
  setDeviceLive: (deviceId: string) => Promise<void>
  setSyncRecordingLive: (enabled: boolean) => Promise<void>
} {
  const isListening = useAppStore((s) => s.isListening)
  const setListening = useAppStore((s) => s.setListening)
  const setPipelineStatus = useAppStore((s) => s.setPipelineStatus)
  const setSttLinkStatus = useAppStore((s) => s.setSttLinkStatus)
  const setAudio = useAppStore((s) => s.setAudio)
  const setInputLevel = useAppStore((s) => s.setInputLevel)
  const setAudioStats = useAppStore((s) => s.setAudioStats)
  const bumpVadSegment = useAppStore((s) => s.bumpVadSegment)
  const upsertTranscript = useAppStore((s) => s.upsertTranscript)
  const setPartialText = useAppStore((s) => s.setPartialText)
  const upsertTranslation = useAppStore((s) => s.upsertTranslation)
  const removeTranslation = useAppStore((s) => s.removeTranslation)
  const degradeToOffline = useAppStore((s) => s.degradeToOffline)
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
  /** Serializes drain loops across stop/start cycles (stale loops must not clobber the flag) */
  const drainGenRef = useRef(0)
  /** Debug stats cadence (500ms) — meters themselves go through meterBus, not the store */
  const lastStatsPushRef = useRef(0)
  /** STT instrumentation: when the utterance was flushed + its audio length */
  const sttFlushAtRef = useRef(0)
  const sttSegDurRef = useRef<number | undefined>(undefined)

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  /** Latest device list for session-start logging (avoids stale closures) */
  const devicesRef = useRef<MediaDeviceInfo[]>([])
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
      devicesRef.current = list
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
    const drainGen = ++drainGenRef.current

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
      const translateStartedAt = performance.now()
      const throttledUi = createThrottledEmitter(80)

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
      let firstTokenAt: number | null = null
      try {
        assembled = await llm.translateStream(
          userContent,
          (chunk) => {
            if (firstTokenAt === null) firstTokenAt = performance.now()
            assembled += chunk
            // Coalesce SSE deltas: one store write per ~80ms instead of per token
            throttledUi.emit(() => {
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
          logSessionEvent({
            module: 'LLM',
            model_name: llmCfg.model || llm.label || llmCfg.id,
            content: assembled,
            latency: Math.round(performance.now() - translateStartedAt),
            ...(firstTokenAt !== null
              ? { first_token_ms: Math.round(firstTokenAt - translateStartedAt) }
              : {}),
            direction: actualDirection,
            source_text: job.unit,
            failed: true,
            echo_intercepted: true
          })
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
        logSessionEvent({
          module: 'LLM',
          model_name: llmCfg.model || llm.label || llmCfg.id,
          content: assembled,
          latency: Math.round(performance.now() - translateStartedAt),
          ...(firstTokenAt !== null
            ? { first_token_ms: Math.round(firstTokenAt - translateStartedAt) }
            : {}),
          direction: actualDirection,
          source_text: job.unit
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
        // Research stats need failures too — count/duration per session
        logSessionEvent({
          module: 'LLM',
          model_name: llmCfg.model || llm.label || llmCfg.id,
          content: assembled || `[翻译失败] ${msg}`,
          latency: Math.round(performance.now() - translateStartedAt),
          ...(firstTokenAt !== null
            ? { first_token_ms: Math.round(firstTokenAt - translateStartedAt) }
            : {}),
          direction: actualDirection,
          source_text: job.unit,
          failed: true
        })

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

    // A newer drain (restart) owns the flag now — stale loop exits silently
    if (drainGenRef.current === drainGen) {
      translatingRef.current = false
    }
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
    logSessionEvent({
      module: 'SYS',
      model_name: 'settings',
      content: `llm switch → ${label}`
    })

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
    drainGenRef.current += 1
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
    publishMeter({ inputLevel: 0, pcmRms: 0 })
    lastStatsPushRef.current = 0
    setVadEngine(null)
    setSttLinkStatus('idle')
    logSessionEvent({ module: 'SYS', model_name: '', content: 'session stop' })
    void (async () => {
      const res = await stopSyncRecording()
      if (res.path) {
        setPipelineStatus(
          res.ok
            ? `已停止监听 · 录音已保存 ${res.path}`
            : `已停止监听 · 录音转码失败：${res.error ?? ''}（已保留 ${res.path}）`
        )
      } else {
        setPipelineStatus('已停止监听')
      }
    })()
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
    drainGenRef.current += 1
    lastStatsPushRef.current = 0
    if (llmCfg) {
      llmRef.current = createLlmClient(llmCfg)
    }
    // New JSONL pair per listening session (research workflow: log ↔ recording alignment)
    window.whisperApi?.rotateSessionLog?.()

    setPipelineStatus('正在加载 Silero-VAD…')

    const utteranceMode = isUtteranceLocalStt(sttConfig.provider)
    const fasterWhisper = isFasterWhisperStt(sttConfig.provider)
    // One user-facing sentence-break pause for every mode (VAD redemption +
    // Paraformer stream settle), live-adjustable via the 断句停顿 slider
    const vadSilenceMs = clampVadSilenceMs(audio.vadSilenceMs)
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
          logSessionEvent({
            module: 'VAD',
            model_name: 'silero',
            content: `#${count} ${seg.reason} ${dur}ms`,
            duration_ms: dur,
            reason: seg.reason
          })
          const link = useAppStore.getState().sttLinkStatus
          // Don't overwrite disconnect / reconnect banners with VAD chatter
          if (link === 'connected') {
            setPipelineStatus(
              utteranceMode
                ? `VAD #${count} · ${seg.reason} · ${dur}ms → 整句发送`
                : `VAD #${count} · ${seg.reason} · ${dur}ms → is_final`
            )
          }
          // Arm STT latency measurement (flush → final text)
          sttFlushAtRef.current = performance.now()
          sttSegDurRef.current = dur
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
        const sttModel =
          useAppStore.getState().settings.stt.model ||
          useAppStore.getState().settings.stt.provider
        // flush → final text latency + the utterance's audio length
        const sttLatency = sttFlushAtRef.current
          ? Math.round(performance.now() - sttFlushAtRef.current)
          : undefined
        logSessionEvent({
          module: 'STT',
          model_name: sttModel,
          content: text,
          ...(sttLatency != null ? { latency: sttLatency } : {}),
          ...(sttSegDurRef.current != null ? { duration_ms: sttSegDurRef.current } : {})
        })
        sttFlushAtRef.current = 0
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

      // Local engines: make sure the backend process is up (auto-launched on
      // app boot for the default engine; spawn now if it died / was switched)
      const engineKey = localSttLauncherKey(sttConfig.provider)
      if (engineKey) {
        setPipelineStatus(`正在连接 ${sttLabel} · 确认本地引擎…`)
        try {
          const ensured = await window.whisperApi?.ensureSttEngine?.(engineKey, 60000)
          if (ensured && !ensured.ok) {
            setPipelineStatus(
              `本地引擎未就绪（${ensured.error ?? '超时'}）· 仍将尝试连接…`
            )
          }
          // 6 GB VRAM fits one resident engine — drop others we spawned
          void window.whisperApi?.stopOtherSttEngines?.(engineKey)
        } catch {
          /* launcher unavailable — fall through to plain connect */
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

      if (audio.syncRecording) {
        const rec = await startSyncRecording(audio.recordingFormat ?? 'wav')
        if (!rec.ok) {
          setPipelineStatus(`同步录音启动失败：${rec.error ?? 'unknown'}`)
        }
      } else {
        useAppStore.getState().setRecordingUiStatus('ready')
      }

      await capture.start({
        volume: audio.volume,
        gain: audio.gain,
        deviceId: audio.deviceId || undefined,
        onPcm: (packet) => {
          vadRef.current?.pushPcm(packet)
          sttRef.current?.sendPcm(packet)
          appendSyncRecordingPcm(packet.samples)
        },
        onLevel: (snap: AudioLevelSnapshot) => {
          // Hot path: meters paint via direct DOM writes from meterBus —
          // no React state, no quantization, full 50ms cadence.
          publishMeter({ inputLevel: snap.inputLevel, pcmRms: snap.pcmRms })
          // Cold path: store keeps a 500ms debug snapshot (panel text + future consumers)
          const now = performance.now()
          if (now - lastStatsPushRef.current >= 500) {
            lastStatsPushRef.current = now
            setInputLevel(snap.inputLevel)
            setAudioStats({
              pcmRms: snap.pcmRms,
              framesEmitted: snap.framesEmitted,
              contextSampleRate: snap.contextSampleRate
            })
          }
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
      const inputDevice = audio.deviceId
        ? devicesRef.current.find((d) => d.deviceId === audio.deviceId)?.label ||
          `device:${audio.deviceId.slice(0, 8)}`
        : 'system-default'
      logSessionEvent({
        module: 'SYS',
        model_name: `${sttConfig.provider} + ${llmCfg?.model ?? 'none'}`,
        content: `session start · VAD=${vad.engine}${isSyncRecordingActive() ? ' · sync-recording' : ''}`,
        vad_silence_ms: vadSilenceMs,
        max_sentence_ms: Math.round(audio.maxSentenceMs),
        input_device: inputDevice,
        sample_rate_hz: 16000,
        ...(getLastRecordingFile() ? { recording_file: getLastRecordingFile() } : {})
      })
      setPipelineStatus(
        `监听中 · ${engineLabel}-VAD(${vadSilenceMs}ms) → ${sttLabel} → ${llmLabel}${
          isSyncRecordingActive() ? ' · 同步录音中' : ''
        }`
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
        logSessionEvent({
          module: 'SYS',
          model_name: 'settings',
          content: `stt hot-switch → faster-whisper ${nextFw}`
        })
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
    logSessionEvent({
      module: 'SYS',
      model_name: 'settings',
      content: `stt switch ${prev.provider} → ${sttProvider}`
    })
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
      const prev = useAppStore.getState().settings.audio.maxSentenceMs
      if (clamped === prev) return
      setAudio({ maxSentenceMs: clamped })
      vadRef.current?.setMaxSentenceMs(clamped)
      const utterance = isUtteranceLocalStt(
        useAppStore.getState().settings.stt.provider
      )
      sttRef.current?.configure?.({
        maxUtteranceMs: utterance ? clamped : Math.min(10000, clamped)
      })
      logSessionEvent({
        module: 'SYS',
        model_name: 'settings',
        content: `max_sentence_ms ${prev} → ${clamped}`,
        max_sentence_ms: clamped
      })
    },
    [setAudio]
  )

  const setSilenceLive = useCallback(
    (ms: number) => {
      const clamped = clampVadSilenceMs(ms)
      const prev = useAppStore.getState().settings.audio.vadSilenceMs
      if (clamped === prev) return
      setAudio({ vadSilenceMs: clamped })
      // Silero redemption (utterance flush) + Paraformer stream settle
      vadRef.current?.setRedemptionMs?.(clamped)
      sttRef.current?.configure?.({ silenceHoldMs: clamped })
      logSessionEvent({
        module: 'SYS',
        model_name: 'settings',
        content: `vad_silence_ms ${prev} → ${clamped}`,
        vad_silence_ms: clamped
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

  const setSyncRecordingLive = useCallback(
    async (enabled: boolean) => {
      setAudio({ syncRecording: enabled })
      if (!useAppStore.getState().isListening) return
      if (enabled) {
        if (isSyncRecordingActive()) return
        const fmt =
          useAppStore.getState().settings.audio.recordingFormat ?? 'wav'
        const res = await startSyncRecording(fmt)
        if (!res.ok) {
          setPipelineStatus(`同步录音启动失败：${res.error ?? 'unknown'}`)
          setAudio({ syncRecording: false })
          return
        }
        useAppStore.getState().setRecordingUiStatus('recording')
        setPipelineStatus('同步录音已开启')
        return
      }
      const res = await stopSyncRecording()
      if (res.path) {
        setPipelineStatus(
          res.ok
            ? `同步录音已保存 ${res.path}`
            : `同步录音转码失败：${res.error ?? ''}（已保留 ${res.path}）`
        )
      } else {
        setPipelineStatus('同步录音已关闭')
      }
    },
    [setAudio, setPipelineStatus]
  )

  return {
    devices,
    refreshDevices,
    vadSegmentCount,
    vadEngine,
    startListening,
    stopListening,
    restartListening,
    setVolumeLive,
    setGainLive,
    setMaxSentenceLive,
    setSilenceLive,
    setDeviceLive,
    setSyncRecordingLive
  }
}
