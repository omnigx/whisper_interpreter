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

/** 探测响应解析：JSON {text,lang} 或纯文本。无副作用（不触碰 pendingLang） */
function decodeTranscriptText(data: unknown): string | null {
  let raw = ''
  if (typeof data === 'string') raw = data.trim()
  else if (data instanceof ArrayBuffer) {
    try {
      raw = new TextDecoder().decode(data).trim()
    } catch {
      return null
    }
  }
  if (!raw) return null
  if (raw.startsWith('{')) {
    try {
      const msg = JSON.parse(raw) as { text?: string; transcript?: string }
      return String(msg.text ?? msg.transcript ?? '').trim() || null
    } catch {
      return null
    }
  }
  return raw
}

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
  /** Engine LID tag captured from the latest JSON frame (null for plain text) */
  private pendingLang: string | null = null
  // ---- 标点探测（punctuation probing）----
  // 独立第二连接：探测响应与正式 final 天然隔离（老服务端也只会回 final
  // 文本，本连接一律按探测处理），主路径零协议变更、零风险。
  private probeWs: WebSocket | null = null
  private probeGen = 0
  private probeBusy = false
  private lastFlushAt = 0

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
    const out = this.concatBuffer()
    this.clearBuffer()
    this.lastFlushAt = performance.now()
    this.sendPcmInt16(out)
  }

  clearBuffer(): void {
    this.buf = []
    this.samples = 0
  }

  /**
   * 标点探测：把当前缓冲（自上次 flush 起的全部音频，即正式段将转写的
   * 同一内容）重复送转写，但不清空缓冲、不走主连接。结果为探测文本，
   * null = 本轮跳过（缓冲过短/过长、连接未就绪、刚 flush 过、超时）。
   * 全程静默失败——探测是尽力而为的加速器，绝不能影响主路径。
   */
  probeUtterance(): Promise<string | null> {
    // <0.8s 不够一个句子；>12s 即将撞 15s 上限，让兜底自然切，避免长缓冲
    // 探测（~1s CPU）与正式段转写在服务端排队争抢
    if (this.samples < 16000 * 0.8 || this.samples > 16000 * 12) {
      return Promise.resolve(null)
    }
    // 刚 flush 过：服务端正在转写正式段
    if (performance.now() - this.lastFlushAt < 1200) return Promise.resolve(null)
    if (this.probeBusy) return Promise.resolve(null)
    const ws = this.ensureProbeSocket()
    if (!ws) return Promise.resolve(null)
    const pcm = this.concatBuffer()
    this.probeBusy = true
    const gen = ++this.probeGen
    return new Promise<string | null>((resolve) => {
      let settled = false
      const done = (v: string | null): void => {
        if (settled || gen !== this.probeGen) return
        settled = true
        window.clearTimeout(timer)
        ws.onmessage = null
        resolve(v)
      }
      const timer = window.setTimeout(() => {
        if (this.probeWs === ws) {
          // 挂起的探测让位给下一次：丢弃这只可能失速的连接
          this.detachProbe(ws)
        }
        done(null)
      }, 3000)
      ws.onclose = () => {
        if (this.probeWs === ws) this.probeWs = null
        done(null)
      }
      ws.onmessage = (ev) => done(decodeTranscriptText(ev.data))
      try {
        ws.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
      } catch {
        this.detachProbe(ws)
        done(null)
      }
    }).finally(() => {
      if (gen === this.probeGen) this.probeBusy = false
    })
  }

  /** 探测连接懒建立；返回就绪的 socket，未就绪（刚发起连接）返回 null */
  private ensureProbeSocket(): WebSocket | null {
    const cur = this.probeWs
    if (cur) {
      if (cur.readyState === WebSocket.OPEN) return cur
      if (cur.readyState === WebSocket.CONNECTING) return null
      this.probeWs = null
    }
    try {
      const ws = new WebSocket(this.url)
      ws.binaryType = 'arraybuffer'
      ws.onerror = () => undefined
      ws.onclose = () => {
        if (this.probeWs === ws) this.probeWs = null
      }
      this.probeWs = ws
    } catch {
      this.probeWs = null
    }
    return null
  }

  private detachProbe(ws: WebSocket): void {
    ws.onclose = null
    ws.onmessage = null
    ws.onerror = null
    if (this.probeWs === ws) this.probeWs = null
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    } catch {
      /* ignore */
    }
  }

  private concatBuffer(): Int16Array {
    const out = new Int16Array(this.samples)
    let offset = 0
    for (const chunk of this.buf) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }

  disconnect(): void {
    this.connectGen += 1
    this.intentionalClose = true
    this.clearReconnect()
    this.clearBuffer()
    // 探测连接一并拆除；进行中的探测静默作废（probeGen 已被新探测递增场景除外）
    this.probeGen += 1
    this.probeBusy = false
    if (this.probeWs) this.detachProbe(this.probeWs)
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
        const msg = JSON.parse(raw) as {
          text?: string
          transcript?: string
          lang?: string | null
        }
        this.pendingLang = typeof msg.lang === 'string' && msg.lang ? msg.lang : null
        return String(msg.text ?? msg.transcript ?? '').trim()
      } catch {
        this.pendingLang = null
        return raw
      }
    }
    this.pendingLang = null
    return raw
  }

  /** Engine LID tag from the just-delivered frame; resets on read. */
  takeLang(): string | null {
    const v = this.pendingLang
    this.pendingLang = null
    return v
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
