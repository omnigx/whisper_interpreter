/**
 * Paraformer streaming STT over WebSocket + Hybrid Chunking.
 *
 * Send: Int16 PCM ArrayBuffer (~200ms) + plain string "is_final"
 * Receive: JSON { type: "partial"|"final", text }
 *
 * Settle triggers (mutually locked via isSettling until backend final):
 *   A) Semantic punctuation in partial → is_final
 *   B) Energy silence ≥ 300ms with non-empty partial → is_final
 *   C) Hard timeout ≥ 10s from first partial char → is_final
 */

import {
  cutAtSentencePunctuation,
  DEFAULT_MAX_SENTENCE_MS,
  DEFAULT_SILENCE_HOLD_MS,
  DEFAULT_SILENCE_RMS,
  type HybridSettleReason
} from './hybridChunking'

export type SenseVoiceStatus = 'connecting' | 'connected' | 'disconnected' | 'error'
export type SettleReason = HybridSettleReason

export interface SenseVoiceSettleParams {
  /** Silence hold before is_final (default 300ms) */
  silenceHoldMs?: number
  /** Hard timeout from first partial character (default 10000ms) */
  maxDurationMs?: number
  /** RMS speech gate; default 0.012 */
  silenceThreshold?: number
  /** Built-in energy + punctuation settle (default true) */
  autoSettle?: boolean
  /** Mechanism A: punctuation → is_final (default true) */
  punctuationSettle?: boolean
}

export interface SenseVoiceClientOptions extends SenseVoiceSettleParams {
  url?: string
  /** Default false — prevents reconnect storms */
  autoReconnect?: boolean
  reconnectDelayMs?: number
  onPartial?: (text: string) => void
  onFinal?: (text: string) => void
  onSettled?: (reason: SettleReason) => void
  /** @deprecated use onPartial/onFinal */
  onTranscript?: (text: string) => void
  onStatus?: (status: SenseVoiceStatus) => void
  onError?: (message: string) => void
}

const DEFAULT_URL = 'ws://127.0.0.1:8766'
/** ~200ms at 16 kHz mono */
export const STREAM_CHUNK_SAMPLES = 3200
const SAMPLE_RATE = 16000

export class SenseVoiceClient {
  private ws: WebSocket | null = null
  private url: string
  private intentionalClose = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private connectGen = 0
  private autoReconnect = false
  private reconnectDelayMs = 3000
  private opts: SenseVoiceClientOptions
  private streamBuf: Int16Array[] = []
  private streamSamples = 0

  /** Hybrid settle config */
  private autoSettle = true
  private punctuationSettle = true
  private silenceHoldMs = DEFAULT_SILENCE_HOLD_MS
  private maxDurationMs = DEFAULT_MAX_SENTENCE_MS
  private silenceThreshold = DEFAULT_SILENCE_RMS

  /**
   * Lock: after sending is_final, block further settles until backend final.
   */
  private isSettling = false

  private lastPartialText = ''
  private partialStartedAt = 0
  private silenceMs = 0
  private utteranceActive = false

  constructor(opts: SenseVoiceClientOptions = {}) {
    this.opts = opts
    this.url = opts.url?.trim() || DEFAULT_URL
    this.autoReconnect = opts.autoReconnect === true
    this.reconnectDelayMs = Math.max(1000, opts.reconnectDelayMs ?? 3000)
    this.applySettleParams(opts)
  }

  get status(): SenseVoiceStatus {
    if (!this.ws) return 'disconnected'
    switch (this.ws.readyState) {
      case WebSocket.CONNECTING:
        return 'connecting'
      case WebSocket.OPEN:
        return 'connected'
      default:
        return 'disconnected'
    }
  }

  get settling(): boolean {
    return this.isSettling
  }

  setUrl(url: string): void {
    this.url = url.trim() || DEFAULT_URL
  }

  setSettleParams(params: SenseVoiceSettleParams): void {
    this.applySettleParams(params)
  }

  setCallbacks(partial: Partial<SenseVoiceClientOptions>): void {
    this.opts = { ...this.opts, ...partial }
  }

  connect(): Promise<void> {
    const gen = ++this.connectGen
    this.teardownSocket()
    this.intentionalClose = false
    this.opts.onStatus?.('connecting')

    return new Promise((resolve, reject) => {
      if (gen !== this.connectGen) {
        reject(new Error('连接已取消'))
        return
      }

      let settled = false
      const ws = new WebSocket(this.url)
      ws.binaryType = 'arraybuffer'
      this.ws = ws

      const timer = window.setTimeout(() => {
        if (settled || gen !== this.connectGen) return
        settled = true
        this.detachHandlers(ws)
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        if (this.ws === ws) this.ws = null
        this.opts.onStatus?.('error')
        reject(new Error(`WebSocket 连接超时: ${this.url}`))
      }, 8000)

      ws.onopen = () => {
        if (gen !== this.connectGen) {
          this.detachHandlers(ws)
          try {
            ws.close()
          } catch {
            /* ignore */
          }
          return
        }
        window.clearTimeout(timer)
        settled = true
        this.reconnectAttempts = 0
        this.opts.onStatus?.('connected')
        resolve()
      }

      ws.onerror = () => {
        if (gen !== this.connectGen || settled) return
        window.clearTimeout(timer)
        settled = true
        this.opts.onStatus?.('error')
        this.opts.onError?.(
          `无法连接 ${this.url}。请先运行 python_dir\\2_paraformer.bat（server_stream.py）。`
        )
        reject(new Error(`WebSocket error: ${this.url}`))
      }

      ws.onclose = () => {
        window.clearTimeout(timer)
        if (gen !== this.connectGen) return
        if (this.ws === ws) this.ws = null
        this.opts.onStatus?.('disconnected')
        if (!this.intentionalClose) {
          this.opts.onError?.(`STT 连接已断开（${this.url}）。正在尝试自动重连…`)
          if (this.autoReconnect) {
            this.scheduleReconnect(gen)
          }
        }
      }

      ws.onmessage = (ev) => {
        if (gen !== this.connectGen) return
        this.handleSocketMessage(ev.data)
      }
    })
  }

  /**
   * Push PCM; auto-flush every ~200ms as ArrayBuffer.
   * Mechanism B/C evaluated on each frame.
   */
  pushStreamPcm(pcm: Int16Array): void {
    if (pcm.length === 0) return
    this.streamBuf.push(pcm)
    this.streamSamples += pcm.length
    while (this.streamSamples >= STREAM_CHUNK_SAMPLES) {
      this.flushStreamChunk(STREAM_CHUNK_SAMPLES)
    }

    if (this.autoSettle) {
      this.trackUtteranceEnergy(pcm)
    }
  }

  flushStreamRemainder(): void {
    if (this.streamSamples > 0) {
      this.flushStreamChunk(this.streamSamples)
    }
  }

  /**
   * Request settle (A/B/C/manual). Locked until backend `final`.
   */
  settleUtterance(reason: SettleReason = 'manual'): void {
    this.requestSettle(reason)
  }

  sendPcmInt16(pcm: Int16Array): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (pcm.length === 0) return
    ws.send(toSendBuffer(pcm))
  }

  sendIsFinal(): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('[STT] skip is_final — WebSocket not open')
      return
    }
    ws.send('is_final')
    console.debug('[STT] sent is_final')
  }

  disconnect(): void {
    this.connectGen += 1
    this.intentionalClose = true
    this.clearReconnect()
    this.streamBuf = []
    this.streamSamples = 0
    this.resetUtteranceState()
    this.teardownSocket()
    this.opts.onStatus?.('disconnected')
  }

  private teardownSocket(): void {
    this.clearReconnect()
    const ws = this.ws
    this.ws = null
    if (!ws) return
    this.detachHandlers(ws)
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    } catch {
      /* ignore */
    }
  }

  private detachHandlers(ws: WebSocket): void {
    ws.onopen = null
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
  }

  private handleSocketMessage(data: unknown): void {
    const raw = this.coerceMessageText(data)
    if (!raw) return

    try {
      const msg = JSON.parse(raw) as Record<string, unknown>
      const type = String(msg.type ?? '').toLowerCase()
      const text = String(msg.text ?? msg.result ?? msg.transcript ?? '').trim()

      if (type === 'partial' || type === 'intermediate' || type === 'delta') {
        this.handlePartialMessage(text)
        return
      }

      const isFinal =
        type === 'final' ||
        type === 'finish' ||
        type === 'completed' ||
        msg.is_final === true ||
        msg.speech_final === true

      if (isFinal) {
        this.handleFinalMessage(text)
        return
      }
    } catch {
      this.handleFinalMessage(raw)
    }
  }

  /**
   * Mechanism A: punctuation in partial → cut + is_final
   * Mechanism C: hard timeout from first partial char
   */
  private handlePartialMessage(text: string): void {
    if (!text) {
      this.opts.onPartial?.('')
      return
    }

    // Start sliding max window on first character of this utterance
    if (!this.partialStartedAt) {
      this.partialStartedAt = Date.now()
    }

    const { head, hasEnd } = cutAtSentencePunctuation(text)
    this.lastPartialText = head
    this.utteranceActive = true
    // Fresh recognition text ⇒ speaker still active; reset silence hold
    this.silenceMs = 0

    // UI shows cut head when punctuation present
    this.opts.onPartial?.(head)

    if (!this.autoSettle || this.isSettling) return

    // A — semantic punctuation
    if (this.punctuationSettle && hasEnd) {
      this.requestSettle('punctuation')
      return
    }

    // C — hard timeout from first partial char
    if (Date.now() - this.partialStartedAt >= this.maxDurationMs) {
      this.requestSettle('max-duration')
    }
  }

  private handleFinalMessage(text: string): void {
    // Unlock settle gate — only final releases isSettling
    this.resetUtteranceState()
    this.opts.onFinal?.(text)
    if (text) this.opts.onTranscript?.(text)
  }

  private requestSettle(reason: SettleReason): void {
    if (this.isSettling) return

    // B: silence only when we have real partial text
    if (reason === 'silence' && !this.lastPartialText.trim()) return

    // Nothing to settle if we never opened an utterance (except manual stop)
    if (reason !== 'manual' && !this.utteranceActive && !this.lastPartialText.trim()) {
      return
    }

    this.isSettling = true
    // Reset VAD silence + max window timers (lock held until final)
    this.silenceMs = 0
    this.partialStartedAt = 0

    this.flushStreamRemainder()
    this.sendIsFinal()
    this.opts.onSettled?.(reason)
  }

  private trackUtteranceEnergy(pcm: Int16Array): void {
    if (this.isSettling) return

    const frameMs = (pcm.length / SAMPLE_RATE) * 1000
    const rms = computeRmsInt16(pcm)

    // C — also check timeout on audio clock (in case partials stall)
    if (
      this.partialStartedAt > 0 &&
      Date.now() - this.partialStartedAt >= this.maxDurationMs
    ) {
      this.requestSettle('max-duration')
      return
    }

    if (rms >= this.silenceThreshold) {
      this.utteranceActive = true
      this.silenceMs = 0
      return
    }

    // B — dynamic silence (300ms) only with non-empty partial buffer
    if (!this.utteranceActive && !this.lastPartialText.trim()) return

    this.silenceMs += frameMs
    if (this.silenceMs >= this.silenceHoldMs) {
      this.requestSettle('silence')
    }
  }

  private applySettleParams(params: SenseVoiceSettleParams): void {
    if (params.silenceHoldMs != null) {
      this.silenceHoldMs = Math.max(150, params.silenceHoldMs)
    }
    if (params.maxDurationMs != null) {
      this.maxDurationMs = Math.min(30000, Math.max(3000, params.maxDurationMs))
    }
    if (params.silenceThreshold != null) {
      this.silenceThreshold = params.silenceThreshold
    }
    if (params.autoSettle != null) {
      this.autoSettle = params.autoSettle
    }
    if (params.punctuationSettle != null) {
      this.punctuationSettle = params.punctuationSettle
    }
  }

  private resetUtteranceState(): void {
    this.utteranceActive = false
    this.silenceMs = 0
    this.partialStartedAt = 0
    this.lastPartialText = ''
    // final or disconnect → unlock for next sentence
    this.isSettling = false
  }
  private coerceMessageText(data: unknown): string {
    if (typeof data === 'string') return data.trim()
    if (data instanceof ArrayBuffer) {
      try {
        return new TextDecoder().decode(data).trim()
      } catch {
        return ''
      }
    }
    if (ArrayBuffer.isView(data)) {
      try {
        const view = data as ArrayBufferView
        return new TextDecoder()
          .decode(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
          .trim()
      } catch {
        return ''
      }
    }
    return ''
  }

  private flushStreamChunk(sampleCount: number): void {
    const out = new Int16Array(sampleCount)
    let offset = 0
    while (offset < sampleCount && this.streamBuf.length > 0) {
      const head = this.streamBuf[0]!
      const need = sampleCount - offset
      if (head.length <= need) {
        out.set(head, offset)
        offset += head.length
        this.streamBuf.shift()
      } else {
        out.set(head.subarray(0, need), offset)
        this.streamBuf[0] = head.subarray(need)
        offset += need
      }
    }
    this.streamSamples -= sampleCount
    this.sendPcmInt16(out)
  }

  private scheduleReconnect(gen: number): void {
    this.clearReconnect()
    if (this.reconnectAttempts >= 5) {
      this.opts.onError?.(
        `STT 多次重连失败（${this.url}）。请确认服务仍在运行，然后重新「开始听写」。`
      )
      this.opts.onStatus?.('error')
      return
    }
    const delay = Math.max(
      this.reconnectDelayMs,
      Math.min(15000, this.reconnectDelayMs * 2 ** this.reconnectAttempts)
    )
    this.reconnectAttempts += 1
    this.opts.onStatus?.('connecting')
    this.reconnectTimer = setTimeout(() => {
      if (gen !== this.connectGen || this.intentionalClose) return
      void this.connect().catch(() => undefined)
    }, delay)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}

export function float32ToInt16(floatSamples: Float32Array): Int16Array {
  const out = new Int16Array(floatSamples.length)
  for (let i = 0; i < floatSamples.length; i++) {
    const s = Math.max(-1, Math.min(1, floatSamples[i]!))
    out[i] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0
  }
  return out
}

/** Exact-size buffers (worklet transfers / fresh merges) are sent zero-copy. */
export function toSendBuffer(pcm: Int16Array): ArrayBuffer {
  if (pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength) {
    return pcm.buffer as ArrayBuffer
  }
  return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)
}

export function concatInt16(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Int16Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

export function computeRmsInt16(samples: Int16Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const f = samples[i]! / 32768
    sum += f * f
  }
  return Math.sqrt(sum / samples.length)
}

export {
  cutAtSentencePunctuation,
  hasSentencePunctuation,
  DEFAULT_MAX_SENTENCE_MS,
  DEFAULT_SILENCE_HOLD_MS
} from './hybridChunking'
