/**
 * SenseVoice utterance STT over WebSocket.
 * - Buffer 16kHz Int16 PCM locally
 * - On VAD flush: send one ArrayBuffer, clear buffer
 * - Receive: plain text → final (no JSON, no is_final)
 *
 * Connection safety: no default auto-reconnect; stale socket handlers are nulled
 * before close to prevent reconnect storms.
 */

export type UtteranceWsStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface SenseVoiceUtteranceOptions {
  url?: string
  /** Default false — only reconnect when explicitly enabled */
  autoReconnect?: boolean
  /** Min delay before reconnect (ms), default 3000 */
  reconnectDelayMs?: number
  onTranscript?: (text: string) => void
  onStatus?: (status: UtteranceWsStatus) => void
  onError?: (message: string) => void
}

const DEFAULT_URL = 'ws://127.0.0.1:8765'

export class SenseVoiceUtteranceClient {
  private ws: WebSocket | null = null
  private url: string
  private intentionalClose = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private connectGen = 0
  private autoReconnect = false
  private reconnectDelayMs = 3000
  private opts: SenseVoiceUtteranceOptions
  private buf: Int16Array[] = []
  private samples = 0

  constructor(opts: SenseVoiceUtteranceOptions = {}) {
    this.opts = opts
    this.url = opts.url?.trim() || DEFAULT_URL
    this.autoReconnect = opts.autoReconnect === true
    this.reconnectDelayMs = Math.max(1000, opts.reconnectDelayMs ?? 3000)
  }

  get status(): UtteranceWsStatus {
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

  setUrl(url: string): void {
    this.url = url.trim() || DEFAULT_URL
  }

  setCallbacks(partial: Partial<SenseVoiceUtteranceOptions>): void {
    this.opts = { ...this.opts, ...partial }
  }

  connect(): Promise<void> {
    const gen = ++this.connectGen
    this.teardownSocket(true)
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
          `无法连接 ${this.url}。请先运行 python_dir\\1_sensevoice.bat（server_sensevoice.py）。`
        )
        reject(new Error(`WebSocket error: ${this.url}`))
      }

      ws.onclose = () => {
        window.clearTimeout(timer)
        if (gen !== this.connectGen) return
        if (this.ws === ws) this.ws = null
        this.opts.onStatus?.('disconnected')
        if (!this.intentionalClose) {
          this.opts.onError?.(
            `SenseVoice 连接已断开（${this.url}）。正在尝试自动重连…`
          )
          if (this.autoReconnect) {
            this.scheduleReconnect(gen)
          }
        }
      }

      ws.onmessage = (ev) => {
        if (gen !== this.connectGen) return
        const text = this.coercePlainText(ev.data)
        if (!text) return
        this.opts.onTranscript?.(text)
      }
    })
  }

  pushPcm(pcm: Int16Array): void {
    if (pcm.length === 0) return
    const copy = new Int16Array(pcm.length)
    copy.set(pcm)
    this.buf.push(copy)
    this.samples += copy.length
  }

  flushUtterance(): void {
    if (this.samples === 0) return
    const out = new Int16Array(this.samples)
    let offset = 0
    for (const chunk of this.buf) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    this.clearBuffer()
    this.sendPcmInt16(out)
  }

  clearBuffer(): void {
    this.buf = []
    this.samples = 0
  }

  disconnect(): void {
    this.connectGen += 1
    this.intentionalClose = true
    this.clearReconnect()
    this.clearBuffer()
    this.teardownSocket(false)
    this.opts.onStatus?.('disconnected')
  }

  private teardownSocket(beforeNewConnect: boolean): void {
    this.clearReconnect()
    const ws = this.ws
    this.ws = null
    if (!ws) return
    this.detachHandlers(ws)
    if (beforeNewConnect) this.intentionalClose = true
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

  private sendPcmInt16(pcm: Int16Array): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('[STT/SenseVoice] skip flush — WebSocket not open')
      return
    }
    if (pcm.length === 0) return
    // flushUtterance() builds a fresh exact-size array — no extra copy needed
    ws.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
  }

  private coercePlainText(data: unknown): string {
    let raw = ''
    if (typeof data === 'string') raw = data.trim()
    else if (data instanceof ArrayBuffer) {
      try {
        raw = new TextDecoder().decode(data).trim()
      } catch {
        return ''
      }
    } else if (ArrayBuffer.isView(data)) {
      try {
        const view = data as ArrayBufferView
        raw = new TextDecoder()
          .decode(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
          .trim()
      } catch {
        return ''
      }
    }
    if (!raw) return ''
    if (raw.startsWith('{')) {
      try {
        const msg = JSON.parse(raw) as { text?: string; transcript?: string }
        return String(msg.text ?? msg.transcript ?? '').trim()
      } catch {
        return raw
      }
    }
    return raw
  }

  private scheduleReconnect(gen: number): void {
    this.clearReconnect()
    if (this.reconnectAttempts >= 5) {
      this.opts.onError?.(
        `SenseVoice 多次重连失败（${this.url}）。请确认 1_sensevoice.bat 仍在运行，然后重新「开始听写」。`
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
