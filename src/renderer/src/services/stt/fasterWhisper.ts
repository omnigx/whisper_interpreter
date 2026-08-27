/**
 * Faster-Whisper utterance STT over WebSocket (default ws://127.0.0.1:8767).
 *
 * Buffer 16 kHz mono Float32 while Silero VAD is in speech;
 * on silence / max-sentence → send one ArrayBuffer, clear buffer.
 *
 * Hot-swap: same socket for medium ↔ large-v3 via
 *   { action: "switch_model", model: "medium" | "large-v3" }
 */

import type { FasterWhisperModelSize } from '@shared/types'

export type FasterWhisperStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'

export interface FasterWhisperClientOptions {
  url?: string
  /** Initial / desired backend model size */
  model?: FasterWhisperModelSize
  autoReconnect?: boolean
  reconnectDelayMs?: number
  onTranscript?: (text: string) => void
  /** Backend { type: "system", message } or local switch notices */
  onSystem?: (message: string) => void
  onStatus?: (status: FasterWhisperStatus) => void
  onError?: (message: string) => void
}

const DEFAULT_URL = 'ws://127.0.0.1:8767'

export class FasterWhisperClient {
  private ws: WebSocket | null = null
  private url: string
  private model: FasterWhisperModelSize
  private intentionalClose = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private connectGen = 0
  private autoReconnect = false
  private reconnectDelayMs = 3000
  private opts: FasterWhisperClientOptions

  /** VAD sentence buffer (Float32 chunks @ 16 kHz) */
  private sentenceBuffer: Float32Array[] = []
  private bufferedSamples = 0

  constructor(opts: FasterWhisperClientOptions = {}) {
    this.opts = opts
    this.url = opts.url?.trim() || DEFAULT_URL
    this.model = opts.model ?? 'medium'
    this.autoReconnect = opts.autoReconnect === true
    this.reconnectDelayMs = Math.max(1000, opts.reconnectDelayMs ?? 3000)
  }

  get status(): FasterWhisperStatus {
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

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  get currentModel(): FasterWhisperModelSize {
    return this.model
  }

  async connect(): Promise<void> {
    this.intentionalClose = false
    this.clearReconnect()
    this.closeSocketOnly()
    this.clearBuffer()

    const gen = ++this.connectGen
    this.opts.onStatus?.('connecting')

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url)
      ws.binaryType = 'arraybuffer'
      this.ws = ws

      const timer = window.setTimeout(() => {
        if (gen !== this.connectGen) return
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        reject(new Error(`Faster-Whisper 连接超时（${this.url}）`))
      }, 12000)

      ws.onopen = () => {
        if (gen !== this.connectGen) return
        window.clearTimeout(timer)
        this.reconnectAttempts = 0
        this.opts.onStatus?.('connected')
        this.sendSwitchModel(this.model)
        resolve()
      }

      ws.onerror = () => {
        if (gen !== this.connectGen) return
        window.clearTimeout(timer)
        this.opts.onStatus?.('error')
        this.opts.onError?.(`Faster-Whisper WebSocket 错误（${this.url}）`)
        reject(new Error(`Faster-Whisper 连接失败（${this.url}）`))
      }

      ws.onclose = () => {
        if (gen !== this.connectGen) return
        window.clearTimeout(timer)
        this.ws = null
        this.opts.onStatus?.('disconnected')
        if (!this.intentionalClose && this.autoReconnect) {
          this.scheduleReconnect()
        }
      }

      ws.onmessage = (ev) => {
        if (gen !== this.connectGen) return
        this.handleMessage(ev.data)
      }
    })
  }

  /**
   * Hot-swap without closing the socket.
   * If not connected, updates desired model for the next connect().
   */
  switchModel(model: FasterWhisperModelSize): void {
    this.model = model
    this.opts.model = model
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSwitchModel(model)
      return
    }
    // Not open — next connect() will send switch on onopen
    console.info(`[STT/Faster-Whisper] model queued for next connect: ${model}`)
  }

  /** Append mic frames (Int16 → Float32) while VAD speech is active. Does not send. */
  pushPcmInt16(pcm: Int16Array): void {
    if (pcm.length === 0) return
    const f32 = int16ToFloat32(pcm)
    this.sentenceBuffer.push(f32)
    this.bufferedSamples += f32.length
  }

  pushPcmFloat32(pcm: Float32Array): void {
    if (pcm.length === 0) return
    const copy = new Float32Array(pcm.length)
    copy.set(pcm)
    this.sentenceBuffer.push(copy)
    this.bufferedSamples += copy.length
  }

  flushUtterance(): void {
    if (this.bufferedSamples === 0) return
    const merged = new Float32Array(this.bufferedSamples)
    let offset = 0
    for (const chunk of this.sentenceBuffer) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    this.clearBuffer()
    this.sendMergedFloat32(merged)
  }

  clearBuffer(): void {
    this.sentenceBuffer = []
    this.bufferedSamples = 0
  }

  disconnect(): void {
    this.intentionalClose = true
    this.clearReconnect()
    this.connectGen += 1
    this.clearBuffer()
    this.closeSocketOnly()
    this.opts.onStatus?.('disconnected')
  }

  private sendSwitchModel(model: FasterWhisperModelSize): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const payload = JSON.stringify({ action: 'switch_model', model })
    ws.send(payload)
    console.info(`[STT/Faster-Whisper] switch_model → ${model}`)
  }

  private sendMergedFloat32(pcm: Float32Array): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('[STT/Faster-Whisper] skip flush — WebSocket not open')
      return
    }
    if (pcm.length === 0) return
    ws.send(pcm.buffer)
    console.debug(
      `[STT/Faster-Whisper] flushed utterance · ${(pcm.length / 16000).toFixed(2)}s`
    )
  }

  private handleMessage(data: unknown): void {
    if (typeof data === 'string') {
      const raw = data.trim()
      if (!raw) return
      try {
        const msg = JSON.parse(raw) as {
          type?: string
          message?: string
          text?: string
          transcript?: string
          result?: string
        }
        if (msg.type === 'system') {
          const tip = (msg.message || msg.text || raw).trim()
          if (tip) this.opts.onSystem?.(tip)
          return
        }
        const t = (msg.text || msg.transcript || msg.result || '').trim()
        if (t) {
          this.opts.onTranscript?.(t)
          return
        }
      } catch {
        this.opts.onTranscript?.(raw)
      }
      return
    }
    if (data instanceof ArrayBuffer) {
      try {
        this.handleMessage(new TextDecoder().decode(data))
      } catch {
        /* ignore */
      }
    }
  }

  private closeSocketOnly(): void {
    if (!this.ws) return
    const ws = this.ws
    this.ws = null
    try {
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    } catch {
      /* ignore */
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnect()
    this.reconnectAttempts += 1
    if (this.reconnectAttempts > 8) {
      this.opts.onError?.(
        `Faster-Whisper 多次重连失败（${this.url}）。请确认服务在 8767 端口运行。`
      )
      return
    }
    this.opts.onStatus?.('connecting')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect().catch(() => undefined)
    }, this.reconnectDelayMs)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}

function int16ToFloat32(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] / 32768
  }
  return out
}
