import { useCallback, useEffect, useRef, useState } from 'react'
import {
  SenseVoiceClient,
  computeRmsInt16,
  float32ToInt16,
  DEFAULT_MAX_SENTENCE_MS,
  DEFAULT_SILENCE_HOLD_MS,
  type SenseVoiceStatus,
  type SettleReason
} from '../services/stt/sensevoice'
import { SenseVoiceUtteranceClient } from '../services/stt/sensevoiceUtterance'
import {
  defaultSttWebsocketUrl,
  normalizeLocalWsUrl,
  type SttProviderKind
} from '@shared/types'

export type WsConnectionStatus = SenseVoiceStatus
export type LocalSttEngine = 'sensevoice' | 'paraformer'

export interface UseAudioTranscriberOptions {
  engine?: LocalSttEngine
  wsUrl?: string
  maxDuration?: number
  silenceMs?: number
  silenceThreshold?: number
  punctuationSettle?: boolean
  deviceId?: string
  onPartial?: (text: string) => void
  onFinal?: (text: string) => void
  onSettled?: (reason: SettleReason | 'utterance-flush') => void
}

export interface UseAudioTranscriberResult {
  startRecording: () => Promise<void>
  stopRecording: () => void
  finalTranscripts: string[]
  partialText: string
  transcripts: string[]
  isRecording: boolean
  connectionStatus: WsConnectionStatus
  inputLevel: number
  clearTranscripts: () => void
  error: string | null
  isSettling: boolean
  engine: LocalSttEngine
}

const TARGET_SAMPLE_RATE = 16000

function engineToProvider(engine: LocalSttEngine): SttProviderKind {
  return engine === 'paraformer' ? 'local-paraformer' : 'local-sensevoice'
}

type AnySttClient = SenseVoiceClient | SenseVoiceUtteranceClient

/**
 * Dual-engine local STT with storm-safe WebSocket lifecycle:
 * - Client lives in useRef (never in useState)
 * - Connect only on startRecording / engine|url change
 * - Callbacks via refs (no reconnect from transcript state)
 * - autoReconnect disabled on clients
 */
export function useAudioTranscriber(
  options: UseAudioTranscriberOptions = {}
): UseAudioTranscriberResult {
  const {
    engine = 'sensevoice',
    wsUrl,
    maxDuration = engine === 'sensevoice' ? 15 : DEFAULT_MAX_SENTENCE_MS / 1000,
    silenceMs = engine === 'sensevoice' ? 800 : DEFAULT_SILENCE_HOLD_MS,
    silenceThreshold = 0.012,
    punctuationSettle = true,
    deviceId,
    onPartial,
    onFinal,
    onSettled
  } = options

  const resolvedUrl = normalizeLocalWsUrl(
    wsUrl?.trim() ||
      defaultSttWebsocketUrl(engineToProvider(engine)) ||
      'ws://127.0.0.1:8765'
  )

  const [finalTranscripts, setFinalTranscripts] = useState<string[]>([])
  const [partialText, setPartialText] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const [isSettling, setIsSettling] = useState(false)
  const [connectionStatus, setConnectionStatus] =
    useState<WsConnectionStatus>('disconnected')
  const [inputLevel, setInputLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)

  /** Single STT client across renders */
  const clientRef = useRef<AnySttClient | null>(null)
  const clientKeyRef = useRef<string>('')
  const connectingRef = useRef(false)

  const ctxRef = useRef<AudioContext | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const recordingRef = useRef(false)

  const speakingRef = useRef(false)
  const silenceAccumMsRef = useRef(0)
  const speechMsRef = useRef(0)
  const flushedRef = useRef(true)

  // Stable callback refs — never put these into connect deps
  const onPartialRef = useRef(onPartial)
  const onFinalRef = useRef(onFinal)
  const onSettledRef = useRef(onSettled)
  onPartialRef.current = onPartial
  onFinalRef.current = onFinal
  onSettledRef.current = onSettled

  const optsRef = useRef({
    engine,
    maxDuration,
    silenceMs,
    silenceThreshold,
    punctuationSettle,
    resolvedUrl,
    deviceId
  })
  optsRef.current = {
    engine,
    maxDuration,
    silenceMs,
    silenceThreshold,
    punctuationSettle,
    resolvedUrl,
    deviceId
  }

  const destroyClient = useCallback(() => {
    connectingRef.current = false
    clientRef.current?.disconnect()
    clientRef.current = null
    clientKeyRef.current = ''
  }, [])

  const teardownAudio = useCallback(() => {
    recordingRef.current = false
    try {
      workletRef.current?.port.close()
    } catch {
      /* ignore */
    }
    workletRef.current?.disconnect()
    processorRef.current?.disconnect()
    sourceRef.current?.disconnect()
    workletRef.current = null
    processorRef.current = null
    sourceRef.current = null
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop())
    mediaStreamRef.current = null
    if (ctxRef.current) {
      void ctxRef.current.close()
      ctxRef.current = null
    }
    speakingRef.current = false
    silenceAccumMsRef.current = 0
    speechMsRef.current = 0
    setInputLevel(0)
    setIsRecording(false)
  }, [])

  /**
   * Create/reuse client for current engine+url. One connection only.
   * Does NOT depend on transcript/partial state.
   */
  const ensureConnected = useCallback(async (): Promise<AnySttClient> => {
    const { engine: eng, resolvedUrl: url, maxDuration: maxSec, silenceMs: hold, silenceThreshold: thr, punctuationSettle: punct } =
      optsRef.current
    const key = `${eng}|${url}`

    if (clientRef.current && clientKeyRef.current === key && clientRef.current.status === 'connected') {
      return clientRef.current
    }

    if (connectingRef.current) {
      // Wait briefly for in-flight connect
      await new Promise((r) => setTimeout(r, 50))
      if (clientRef.current && clientKeyRef.current === key && clientRef.current.status === 'connected') {
        return clientRef.current
      }
    }

    connectingRef.current = true
    destroyClient()
    clientKeyRef.current = key

    const onStatus = (s: SenseVoiceStatus): void => {
      setConnectionStatus(s)
    }
    const onErr = (msg: string): void => {
      setError(msg)
    }

    try {
      if (eng === 'paraformer') {
        const client = new SenseVoiceClient({
          url,
          autoReconnect: false,
          autoSettle: true,
          punctuationSettle: punct,
          silenceHoldMs: hold,
          maxDurationMs: Math.round(maxSec * 1000),
          silenceThreshold: thr,
          onPartial: (text) => {
            setPartialText(text)
            onPartialRef.current?.(text)
          },
          onFinal: (text) => {
            setIsSettling(false)
            setPartialText('')
            const t = text.trim()
            if (t) {
              setFinalTranscripts((prev) => [...prev, t])
              onFinalRef.current?.(t)
            }
          },
          onSettled: (reason) => {
            setIsSettling(true)
            onSettledRef.current?.(reason)
          },
          onStatus,
          onError: onErr
        })
        clientRef.current = client
        await client.connect()
        return client
      }

      const client = new SenseVoiceUtteranceClient({
        url,
        autoReconnect: false,
        onTranscript: (text) => {
          setIsSettling(false)
          setPartialText('')
          const t = text.trim()
          if (t) {
            setFinalTranscripts((prev) => [...prev, t])
            onFinalRef.current?.(t)
          }
        },
        onStatus,
        onError: onErr
      })
      clientRef.current = client
      await client.connect()
      return client
    } finally {
      connectingRef.current = false
    }
  }, [destroyClient])

  const flushSenseVoice = useCallback((reason: string) => {
    if (flushedRef.current) return
    flushedRef.current = true
    speakingRef.current = false
    silenceAccumMsRef.current = 0
    speechMsRef.current = 0
    const c = clientRef.current
    if (c instanceof SenseVoiceUtteranceClient) c.flushUtterance()
    setIsSettling(true)
    onSettledRef.current?.('utterance-flush')
    console.debug(`[STT/SenseVoice] flush · ${reason}`)
  }, [])

  const handlePcmFrame = useCallback(
    (pcm: Int16Array, frameMs: number) => {
      if (!recordingRef.current) return
      const rms = computeRmsInt16(pcm)
      setInputLevel(Math.min(1, rms * 8))

      const { engine: eng, silenceThreshold: thr, silenceMs: hold, maxDuration: maxSec } =
        optsRef.current
      const client = clientRef.current
      if (!client) return

      if (eng === 'paraformer') {
        if (client instanceof SenseVoiceClient) client.pushStreamPcm(pcm)
        return
      }

      if (client instanceof SenseVoiceUtteranceClient) client.pushPcm(pcm)

      if (rms >= thr) {
        speakingRef.current = true
        flushedRef.current = false
        silenceAccumMsRef.current = 0
        speechMsRef.current += frameMs
        if (speechMsRef.current >= maxSec * 1000) flushSenseVoice('max-duration')
        return
      }

      if (speakingRef.current) {
        silenceAccumMsRef.current += frameMs
        speechMsRef.current += frameMs
        if (silenceAccumMsRef.current >= hold) flushSenseVoice('silence')
        else if (speechMsRef.current >= maxSec * 1000) flushSenseVoice('max-duration')
      }
    },
    [flushSenseVoice]
  )

  const stopRecording = useCallback(() => {
    const eng = optsRef.current.engine
    if (eng === 'sensevoice' && !flushedRef.current) {
      flushSenseVoice('stop')
    } else {
      const c = clientRef.current
      if (c instanceof SenseVoiceClient && !c.settling) {
        c.settleUtterance('manual')
        setIsSettling(true)
      }
    }
    teardownAudio()
  }, [flushSenseVoice, teardownAudio])

  const startRecording = useCallback(async () => {
    if (recordingRef.current || connectingRef.current) return
    setError(null)
    setPartialText('')
    setIsSettling(false)

    try {
      await ensureConnected()

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          ...(optsRef.current.deviceId
            ? { deviceId: { exact: optsRef.current.deviceId } }
            : {})
        }
      })
      mediaStreamRef.current = stream

      const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
      ctxRef.current = ctx
      if (ctx.state === 'suspended') await ctx.resume()

      const source = ctx.createMediaStreamSource(stream)
      sourceRef.current = source

      try {
        const workletUrl = new URL('/pcm-capture-processor.js', window.location.origin).href
        await ctx.audioWorklet.addModule(workletUrl)
        const worklet = new AudioWorkletNode(ctx, 'pcm-capture-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE }
        })
        workletRef.current = worklet
        worklet.port.onmessage = (ev: MessageEvent) => {
          const data = ev.data as { type?: string; samples?: Int16Array }
          if (data?.type !== 'pcm' || !data.samples) return
          const frameMs = (data.samples.length / TARGET_SAMPLE_RATE) * 1000
          handlePcmFrame(data.samples, frameMs)
        }
        source.connect(worklet)
      } catch (workletErr) {
        console.warn('[STT] AudioWorklet unavailable, ScriptProcessor fallback', workletErr)
        const processor = ctx.createScriptProcessor(4096, 1, 1)
        processorRef.current = processor
        processor.onaudioprocess = (e) => {
          const input = e.inputBuffer.getChannelData(0)
          let floatFrame: Float32Array
          if (ctx.sampleRate === TARGET_SAMPLE_RATE) {
            floatFrame = new Float32Array(input)
          } else {
            const ratio = ctx.sampleRate / TARGET_SAMPLE_RATE
            const outLen = Math.floor(input.length / ratio)
            floatFrame = new Float32Array(outLen)
            for (let i = 0; i < outLen; i++) {
              const src = i * ratio
              const i0 = Math.floor(src)
              const i1 = Math.min(i0 + 1, input.length - 1)
              const t = src - i0
              floatFrame[i] = input[i0]! * (1 - t) + input[i1]! * t
            }
          }
          const pcm = float32ToInt16(floatFrame)
          handlePcmFrame(pcm, (pcm.length / TARGET_SAMPLE_RATE) * 1000)
        }
        const mute = ctx.createGain()
        mute.gain.value = 0
        source.connect(processor)
        processor.connect(mute)
        mute.connect(ctx.destination)
      }

      flushedRef.current = true
      recordingRef.current = true
      setIsRecording(true)
    } catch (e) {
      teardownAudio()
      destroyClient()
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      setConnectionStatus((s) => (s === 'connected' ? s : 'error'))
      throw e
    }
  }, [destroyClient, ensureConnected, handlePcmFrame, teardownAudio])

  const clearTranscripts = useCallback(() => {
    setFinalTranscripts([])
    setPartialText('')
  }, [])

  // Engine / URL change while recording → close old WS, connect new (once)
  const engineUrlKey = `${engine}|${resolvedUrl}`
  useEffect(() => {
    if (!recordingRef.current) return
    if (clientKeyRef.current === engineUrlKey) return
    let cancelled = false
    void (async () => {
      try {
        await ensureConnected()
        if (cancelled) return
      } catch {
        /* error state already set */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [engineUrlKey, ensureConnected])

  // Unmount cleanup only — empty deps intentionally
  useEffect(() => {
    return () => {
      recordingRef.current = false
      try {
        workletRef.current?.port.close()
      } catch {
        /* ignore */
      }
      workletRef.current?.disconnect()
      processorRef.current?.disconnect()
      sourceRef.current?.disconnect()
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop())
      if (ctxRef.current) void ctxRef.current.close()
      clientRef.current?.disconnect()
      clientRef.current = null
      clientKeyRef.current = ''
    }
  }, [])

  return {
    startRecording,
    stopRecording,
    finalTranscripts,
    partialText,
    transcripts: finalTranscripts,
    isRecording,
    connectionStatus,
    inputLevel,
    clearTranscripts,
    error,
    isSettling,
    engine
  }
}

export {
  float32ToInt16,
  concatInt16,
  computeRmsInt16,
  DEFAULT_MAX_SENTENCE_MS,
  DEFAULT_SILENCE_HOLD_MS
} from '../services/stt/sensevoice'
