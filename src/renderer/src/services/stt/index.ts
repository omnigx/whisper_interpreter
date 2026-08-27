import type { PcmPacket, SttPartialResult } from '../pipeline'
import type { FasterWhisperModelSize, SttConfig, SttProviderKind } from '@shared/types'
import {
  defaultSttWebsocketUrl,
  fasterWhisperModelSize,
  isFasterWhisperStt,
  isUtteranceLocalStt,
  normalizeLocalWsUrl
} from '@shared/types'
import { SenseVoiceClient } from './sensevoice'
import { SenseVoiceUtteranceClient } from './sensevoiceUtterance'
import { FasterWhisperClient } from './fasterWhisper'

export type SttClientMode = 'utterance' | 'stream'

export interface SttClient {
  readonly kind: SttProviderKind
  /** utterance = SenseVoice/FW buffer+flush; stream = Paraformer/Deepgram */
  readonly mode: SttClientMode
  connect: () => Promise<void>
  disconnect: () => void
  /** Continuous frames: utterance buffers; stream sends (~200ms / live) */
  sendPcm: (packet: PcmPacket) => void
  /**
   * VAD end: utterance → flush ArrayBuffer;
   * Paraformer → settle + "is_final"
   */
  notifyUtteranceEnd?: () => void
  /** Faster-Whisper medium ↔ large-v3 without closing the socket */
  switchFasterWhisperModel?: (model: FasterWhisperModelSize) => void
  configure?: (opts: { maxUtteranceMs?: number; silenceHoldMs?: number }) => void
  onResult: ((result: SttPartialResult) => void) | null
  /** Soft system divider (e.g. STT hot-swap ack) */
  onSystem?: ((message: string) => void) | null
  onError: ((err: Error) => void) | null
  onStatus?: ((status: string) => void) | null
}

export function createSttClient(config: SttConfig): SttClient {
  switch (config.provider) {
    case 'deepgram':
      return createDeepgramClient(config)
    case 'azure':
    case 'aliyun':
      return createGenericStreamingWsClient(config)
    case 'local-paraformer':
      return createParaformerSttClient(config)
    case 'faster-whisper':
    case 'local-faster-whisper':
    case 'faster-whisper-medium':
    case 'faster-whisper-large-v3':
      return createFasterWhisperSttClient(config)
    case 'local-sensevoice':
      return createSenseVoiceUtteranceSttClient(config)
    default:
      return createSenseVoiceUtteranceSttClient({
        ...config,
        provider: 'local-sensevoice',
        websocketUrl: config.websocketUrl || defaultSttWebsocketUrl('local-sensevoice')
      })
  }
}

/** Faster-Whisper: Silero VAD buffer → Float32 utterance; medium/large-v3 hot-swap */
function createFasterWhisperSttClient(config: SttConfig): SttClient {
  const url = normalizeLocalWsUrl(
    config.websocketUrl?.trim() ||
      defaultSttWebsocketUrl(config.provider) ||
      'ws://127.0.0.1:8767'
  )
  let activeModel: FasterWhisperModelSize =
    fasterWhisperModelSize(config.provider) ?? 'medium'
  let client: FasterWhisperClient | null = null
  let utteranceSeq = 0

  const stt: SttClient = {
    kind: isFasterWhisperStt(config.provider) ? config.provider : 'faster-whisper-medium',
    mode: 'utterance',
    onResult: null,
    onSystem: null,
    onError: null,
    onStatus: null,
    async connect() {
      client?.disconnect()
      client = new FasterWhisperClient({
        url,
        model: activeModel,
        autoReconnect: true,
        reconnectDelayMs: 2000,
        onTranscript: (text) => {
          // Each WS text frame = one final sentence (backend may send many per audio chunk)
          utteranceSeq += 1
          const utteranceId = `fw-${Date.now()}-${utteranceSeq}-${Math.random().toString(36).slice(2, 7)}`
          stt.onResult?.({ text, isFinal: true, utteranceId })
        },
        onSystem: (message) => {
          stt.onSystem?.(message)
        },
        onStatus: (s) => stt.onStatus?.(s),
        onError: (msg) => stt.onError?.(new Error(msg))
      })
      await client.connect()
      stt.onStatus?.(
        `Faster-Whisper 整句已连接 · ${activeModel} · ${url}`
      )
    },
    disconnect() {
      client?.disconnect()
      client = null
    },
    sendPcm(packet) {
      client?.pushPcmInt16(packet.samples)
    },
    notifyUtteranceEnd() {
      client?.flushUtterance()
    },
    switchFasterWhisperModel(model) {
      activeModel = model
      if (!client) return
      if (client.isOpen) {
        client.switchModel(model)
      } else {
        client.switchModel(model)
        void client.connect().catch((e) => {
          stt.onError?.(e instanceof Error ? e : new Error(String(e)))
        })
      }
    }
  }
  return stt
}

/** SenseVoice: buffer PCM → VAD flush whole utterance → plain text final */
function createSenseVoiceUtteranceSttClient(config: SttConfig): SttClient {
  const url = normalizeLocalWsUrl(
    config.websocketUrl?.trim() ||
      defaultSttWebsocketUrl(config.provider) ||
      'ws://127.0.0.1:8765'
  )
  let client: SenseVoiceUtteranceClient | null = null
  let utteranceId = `sv-${Date.now()}`

  const stt: SttClient = {
    kind: 'local-sensevoice',
    mode: 'utterance',
    onResult: null,
    onError: null,
    onStatus: null,
    async connect() {
      client?.disconnect()
      client = new SenseVoiceUtteranceClient({
        url,
        autoReconnect: true,
        reconnectDelayMs: 2000,
        onTranscript: (text) => {
          utteranceId = `sv-${Date.now()}`
          stt.onResult?.({ text, isFinal: true, utteranceId })
        },
        onStatus: (s) => stt.onStatus?.(s),
        onError: (msg) => stt.onError?.(new Error(msg))
      })
      await client.connect()
      stt.onStatus?.(`SenseVoice 整句模式已连接 · ${url}`)
    },
    disconnect() {
      client?.disconnect()
      client = null
    },
    sendPcm(packet) {
      client?.pushPcm(packet.samples)
    },
    notifyUtteranceEnd() {
      client?.flushUtterance()
    }
  }
  return stt
}

/** Paraformer streaming: ~200ms PCM + hybrid is_final + JSON partial/final */
function createParaformerSttClient(config: SttConfig): SttClient {
  const url = normalizeLocalWsUrl(
    config.websocketUrl?.trim() ||
      defaultSttWebsocketUrl('local-paraformer') ||
      'ws://127.0.0.1:8766'
  )
  let client: SenseVoiceClient | null = null
  let utteranceId = `pf-${Date.now()}`

  const stt: SttClient = {
    kind: 'local-paraformer',
    mode: 'stream',
    onResult: null,
    onError: null,
    onStatus: null,
    async connect() {
      client?.disconnect()
      client = new SenseVoiceClient({
        url,
        autoReconnect: true,
        reconnectDelayMs: 2000,
        autoSettle: true,
        punctuationSettle: true,
        silenceHoldMs: 300,
        maxDurationMs: 10000,
        onPartial: (text) => {
          stt.onResult?.({ text, isFinal: false, utteranceId })
        },
        onFinal: (text) => {
          utteranceId = `pf-${Date.now()}`
          stt.onResult?.({ text, isFinal: true, utteranceId })
        },
        onSettled: (reason) => {
          stt.onStatus?.(`Paraformer 混合断句 · is_final · ${reason}`)
        },
        onStatus: (s) => stt.onStatus?.(s),
        onError: (msg) => stt.onError?.(new Error(msg))
      })
      await client.connect()
      stt.onStatus?.(`Paraformer 流式已连接 · ${url}`)
    },
    disconnect() {
      client?.disconnect()
      client = null
    },
    sendPcm(packet) {
      client?.pushStreamPcm(packet.samples)
    },
    notifyUtteranceEnd() {
      client?.settleUtterance('manual')
    },
    configure(opts) {
      client?.setSettleParams({
        maxDurationMs: opts.maxUtteranceMs,
        silenceHoldMs: opts.silenceHoldMs
      })
    }
  }
  return stt
}

function createDeepgramClient(config: SttConfig): SttClient {
  let ws: WebSocket | null = null
  let utteranceId = `dg-${Date.now()}`
  const client: SttClient = {
    kind: 'deepgram',
    mode: 'stream',
    onResult: null,
    onError: null,
    onStatus: null,
    async connect() {
      if (!config.apiKey?.trim()) {
        throw new Error('Deepgram API Key 未配置')
      }
      const params = new URLSearchParams({
        encoding: 'linear16',
        sample_rate: '16000',
        channels: '1',
        model: config.model || 'nova-2',
        punctuate: 'true',
        interim_results: 'true',
        smart_format: 'true',
        endpointing: '400'
      })
      if (config.language) params.set('language', config.language)

      const url =
        config.websocketUrl?.trim() ||
        `wss://api.deepgram.com/v1/listen?${params.toString()}`

      await new Promise<void>((resolve, reject) => {
        ws = new WebSocket(url, ['token', config.apiKey.trim()])
        ws.binaryType = 'arraybuffer'
        const timer = setTimeout(() => reject(new Error('Deepgram 连接超时')), 12000)
        ws.onopen = () => {
          clearTimeout(timer)
          client.onStatus?.('Deepgram 已连接')
          resolve()
        }
        ws.onerror = () => {
          clearTimeout(timer)
          reject(new Error('Deepgram WebSocket 连接失败'))
        }
        ws.onclose = () => client.onStatus?.('Deepgram 已断开')
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(String(ev.data)) as {
              type?: string
              channel?: {
                alternatives?: Array<{ transcript?: string }>
              }
              is_final?: boolean
              speech_final?: boolean
            }
            if (msg.type && msg.type !== 'Results') return
            const text = msg.channel?.alternatives?.[0]?.transcript?.trim()
            if (!text) return
            const isFinal = Boolean(msg.is_final || msg.speech_final)
            if (isFinal) utteranceId = `dg-${Date.now()}`
            client.onResult?.({ text, isFinal, utteranceId })
          } catch {
            /* ignore */
          }
        }
      })
    },
    disconnect() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'CloseStream' }))
        } catch {
          /* ignore */
        }
      }
      ws?.close()
      ws = null
    },
    sendPcm(packet) {
      if (ws?.readyState === WebSocket.OPEN) {
        const copy = new Int16Array(packet.samples)
        ws.send(copy.buffer)
      }
    },
    notifyUtteranceEnd() {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'Finalize' }))
      }
    }
  }
  return client
}

/** Azure / Aliyun — streaming binary PCM */
function createGenericStreamingWsClient(config: SttConfig): SttClient {
  let ws: WebSocket | null = null
  let utteranceId = `ws-${Date.now()}`
  const client: SttClient = {
    kind: config.provider,
    mode: 'stream',
    onResult: null,
    onError: null,
    onStatus: null,
    async connect() {
      const url = config.websocketUrl?.trim()
      if (!url) throw new Error(`${config.provider} 需要填写 WebSocket URL`)
      await new Promise<void>((resolve, reject) => {
        ws = new WebSocket(url)
        ws.binaryType = 'arraybuffer'
        const timer = setTimeout(() => reject(new Error('STT WebSocket 连接超时')), 12000)
        ws.onopen = () => {
          clearTimeout(timer)
          client.onStatus?.(`${config.provider} 已连接`)
          resolve()
        }
        ws.onerror = () => {
          clearTimeout(timer)
          reject(new Error(`${config.provider} WebSocket 连接失败`))
        }
        ws.onclose = () => client.onStatus?.(`${config.provider} 已断开`)
        ws.onmessage = (ev) => {
          if (typeof ev.data !== 'string') return
          const text = ev.data.trim()
          if (!text) return
          try {
            const msg = JSON.parse(text) as {
              type?: string
              text?: string
              transcript?: string
            }
            const t = (msg.text || msg.transcript || '').trim()
            if (!t) return
            const isFinal = msg.type === 'final' || msg.type === 'speech_end'
            if (isFinal) utteranceId = `ws-${Date.now()}`
            client.onResult?.({ text: t, isFinal, utteranceId })
          } catch {
            utteranceId = `ws-${Date.now()}`
            client.onResult?.({ text, isFinal: true, utteranceId })
          }
        }
      })
    },
    disconnect() {
      ws?.close()
      ws = null
    },
    sendPcm(packet) {
      if (ws?.readyState === WebSocket.OPEN) {
        const copy = new Int16Array(packet.samples)
        ws.send(copy.buffer)
      }
    }
  }
  return client
}

export { isUtteranceLocalStt }
