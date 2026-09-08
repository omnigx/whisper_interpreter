import type { AudioInputSource } from '@shared/types'
import type { PcmPacket, SileroVadHandle, VadSegment } from './pipeline'

const TARGET_RATE = 16000 as const

export interface AudioLevelSnapshot {
  /** 0–1 peak-ish level from analyser */
  inputLevel: number
  /** last PCM frame RMS (0–1) */
  pcmRms: number
  framesEmitted: number
  sampleRate: number
  contextSampleRate: number
}

export interface AudioCaptureOptions {
  volume?: number
  gain?: number
  deviceId?: string
  /** mic (default) | loopback (system/meeting audio) | mix (both summed) */
  sourceMode?: AudioInputSource
  onPcm?: (packet: PcmPacket) => void
  onLevel?: (level: AudioLevelSnapshot) => void
  onError?: (err: Error) => void
}

export interface AudioCaptureHandle {
  start: (opts?: AudioCaptureOptions) => Promise<void>
  stop: () => void
  setVolume: (v: number) => void
  setGain: (g: number) => void
  setDeviceId: (deviceId: string | undefined) => Promise<void>
  /** Live-switch capture source (mic / loopback / mix) — rebuilds the graph */
  setSourceMode: (mode: AudioInputSource) => Promise<void>
  getAnalyser: () => AnalyserNode | null
  isRunning: () => boolean
}

/**
 * Open the requested input streams.
 * - loopback uses Electron display-capture with audio:'loopback' (main process
 *   setDisplayMediaRequestHandler auto-answers; speakers keep playing — it is
 *   a passive tap of the system output mix, meeting clients are unaware).
 */
async function openInputStreams(
  mode: AudioInputSource,
  deviceId: string | undefined
): Promise<MediaStream[]> {
  const streams: MediaStream[] = []

  if (mode === 'mic' || mode === 'mix') {
    const constraints: MediaTrackConstraints = {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
    if (deviceId) {
      constraints.deviceId = { exact: deviceId }
    }
    streams.push(await navigator.mediaDevices.getUserMedia({ audio: constraints }))
  }

  if (mode === 'loopback' || mode === 'mix') {
    try {
      // Chromium requires a video track in getDisplayMedia; the main-process
      // handler supplies the screen source and 'loopback' audio. We drop the
      // video track immediately and keep only the system-audio track.
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      })
      display.getVideoTracks().forEach((t) => t.stop())
      const audioTracks = display.getAudioTracks()
      if (audioTracks.length === 0) {
        display.getTracks().forEach((t) => t.stop())
        throw new Error('环回流中无音频轨（请确认在 Windows 上运行）')
      }
      streams.push(new MediaStream(audioTracks))
    } catch (e) {
      // Roll back anything we already opened
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`系统声音环回采集失败：${msg}`)
    }
  }

  return streams
}

/**
 * [mic|loopback|mix] → GainNode → VolumeNode → Analyser → AudioWorklet(16k PCM)
 * Multiple sources (mix mode) connect into the same GainNode — WebAudio sums them.
 * Volume / Gain both sit on the capture path so STT/VAD hear the adjusted signal.
 */
export function createAudioCapture(): AudioCaptureHandle {
  let ctx: AudioContext | null = null
  let streams: MediaStream[] = []
  let sourceNodes: MediaStreamAudioSourceNode[] = []
  let gainNode: GainNode | null = null
  let volumeNode: GainNode | null = null
  let analyser: AnalyserNode | null = null
  let worklet: AudioWorkletNode | null = null
  let running = false
  let framesEmitted = 0
  let lastRms = 0
  let levelTimer: number | null = null
  let currentDeviceId: string | undefined
  let currentSourceMode: AudioInputSource = 'mic'
  let currentOpts: AudioCaptureOptions = {}

  const teardownGraph = (): void => {
    if (levelTimer != null) {
      window.clearInterval(levelTimer)
      levelTimer = null
    }
    try {
      worklet?.port.close()
    } catch {
      /* ignore */
    }
    worklet?.disconnect()
    analyser?.disconnect()
    volumeNode?.disconnect()
    gainNode?.disconnect()
    sourceNodes.forEach((n) => n.disconnect())
    worklet = null
    analyser = null
    volumeNode = null
    gainNode = null
    sourceNodes = []
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
    streams = []
    if (ctx) {
      void ctx.close()
      ctx = null
    }
    running = false
  }

  const buildGraph = async (opts: AudioCaptureOptions): Promise<void> => {
    currentOpts = opts
    const sourceMode = opts.sourceMode ?? 'mic'
    currentSourceMode = sourceMode
    currentDeviceId = opts.deviceId ?? currentDeviceId

    const opened = await openInputStreams(sourceMode, currentDeviceId)
    streams = opened
    ctx = new AudioContext({ sampleRate: TARGET_RATE })
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }

    // Worklet URL: served from Vite public/ in dev & build
    const workletUrl = new URL('/pcm-capture-processor.js', window.location.origin).href
    await ctx.audioWorklet.addModule(workletUrl)

    gainNode = ctx.createGain()
    volumeNode = ctx.createGain()
    analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.7

    gainNode.gain.value = clamp(opts.gain ?? 1, 0, 8)
    volumeNode.gain.value = clamp(opts.volume ?? 1, 0, 1)

    worklet = new AudioWorkletNode(ctx, 'pcm-capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: { targetSampleRate: TARGET_RATE }
    })

    worklet.port.onmessage = (ev: MessageEvent) => {
      const data = ev.data as {
        type: string
        samples: Int16Array
        sampleRate: number
        rms: number
        timestamp: number
      }
      if (data?.type !== 'pcm') return
      framesEmitted += 1
      lastRms = data.rms
      const packet: PcmPacket = {
        samples: data.samples,
        sampleRate: TARGET_RATE,
        timestamp: data.timestamp || Date.now()
      }
      currentOpts.onPcm?.(packet)
    }

    // sources → gain → volume → analyser → worklet (sources sum in mix mode)
    sourceNodes = streams.map((s) => ctx!.createMediaStreamSource(s))
    sourceNodes.forEach((n) => n.connect(gainNode!))
    gainNode.connect(volumeNode)
    volumeNode.connect(analyser)
    analyser.connect(worklet)
    // worklet output is silent; do not connect to destination (avoid feedback)

    framesEmitted = 0
    lastRms = 0
    running = true

    const timeDomain = new Uint8Array(analyser.fftSize)
    levelTimer = window.setInterval(() => {
      if (!analyser) return
      analyser.getByteTimeDomainData(timeDomain)
      let peak = 0
      for (let i = 0; i < timeDomain.length; i++) {
        const v = Math.abs(timeDomain[i] - 128) / 128
        if (v > peak) peak = v
      }
      currentOpts.onLevel?.({
        inputLevel: peak,
        pcmRms: lastRms,
        framesEmitted,
        sampleRate: TARGET_RATE,
        contextSampleRate: ctx?.sampleRate ?? TARGET_RATE
      })
    }, 50)
  }

  return {
    async start(opts = {}) {
      if (running) {
        this.stop()
      }
      currentDeviceId = opts.deviceId ?? currentDeviceId
      try {
        await buildGraph({ ...opts, deviceId: currentDeviceId })
      } catch (e) {
        teardownGraph()
        const err = e instanceof Error ? e : new Error(String(e))
        opts.onError?.(err)
        throw err
      }
    },

    stop() {
      teardownGraph()
    },

    setVolume(v: number) {
      currentOpts.volume = clamp(v, 0, 1)
      if (volumeNode) {
        volumeNode.gain.setTargetAtTime(currentOpts.volume, ctx?.currentTime ?? 0, 0.015)
      }
    },

    setGain(g: number) {
      currentOpts.gain = clamp(g, 0, 8)
      if (gainNode) {
        gainNode.gain.setTargetAtTime(currentOpts.gain, ctx?.currentTime ?? 0, 0.015)
      }
    },

    async setDeviceId(deviceId) {
      currentDeviceId = deviceId
      if (running) {
        const opts = { ...currentOpts, deviceId }
        this.stop()
        await this.start(opts)
      }
    },

    async setSourceMode(mode) {
      if (mode === currentSourceMode && running) return
      if (running) {
        const opts = { ...currentOpts, sourceMode: mode }
        this.stop()
        await this.start(opts)
      } else {
        currentSourceMode = mode
      }
    },

    getAnalyser: () => analyser,
    isRunning: () => running
  }
}

export async function listAudioInputDevices(): Promise<MediaDeviceInfo[]> {
  // Labels require prior permission on some platforms
  try {
    const warm = await navigator.mediaDevices.getUserMedia({ audio: true })
    warm.getTracks().forEach((t) => t.stop())
  } catch {
    /* ignore — still list devices without labels */
  }
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((d) => d.kind === 'audioinput')
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/**
 * Lightweight energy VAD (fallback).
 * Emits segments on silence after speech, or when max sentence length is hit.
 */
export function createEnergyVad(
  maxSentenceMs = 15000,
  onSegment?: (seg: VadSegment) => void
): SileroVadHandle {
  let maxMs = clamp(maxSentenceMs, 5000, 30000)
  let speaking = false
  let speechStart = 0
  let silenceMs = 0
  let collected: Int16Array[] = []
  let collectedSamples = 0
  let segmentCb = onSegment
  let silenceHoldMs = 300
  const speechThreshold = 0.02

  const flush = (reason: VadSegment['reason'], endMs: number): void => {
    if (collectedSamples === 0) return
    const pcm = new Int16Array(collectedSamples)
    let offset = 0
    for (const chunk of collected) {
      pcm.set(chunk, offset)
      offset += chunk.length
    }
    const seg: VadSegment = {
      startMs: speechStart,
      endMs,
      pcm,
      reason
    }
    collected = []
    collectedSamples = 0
    speaking = false
    silenceMs = 0
    segmentCb?.(seg)
  }

  return {
    pushPcm(packet) {
      const durationMs = (packet.samples.length / packet.sampleRate) * 1000
      let sum = 0
      for (let i = 0; i < packet.samples.length; i++) {
        const f = packet.samples[i] / 32768
        sum += f * f
      }
      const rms = Math.sqrt(sum / packet.samples.length)
      const now = packet.timestamp

      if (rms >= speechThreshold) {
        if (!speaking) {
          speaking = true
          speechStart = now
          silenceMs = 0
        }
        collected.push(packet.samples)
        collectedSamples += packet.samples.length
        silenceMs = 0

        if (now - speechStart >= maxMs) {
          flush('max-sentence', now)
        }
        return
      }

      if (speaking) {
        collected.push(packet.samples)
        collectedSamples += packet.samples.length
        silenceMs += durationMs
        if (silenceMs >= silenceHoldMs) {
          flush('silence', now)
        } else if (now - speechStart >= maxMs) {
          flush('max-sentence', now)
        }
      }
    },

    setMaxSentenceMs(ms) {
      maxMs = clamp(ms, 5000, 30000)
    },

    /** Same semantic as Silero's setRedemptionMs — silence that ends a sentence */
    setRedemptionMs(ms) {
      silenceHoldMs = Math.max(100, ms)
    },

    setOnSegment(cb) {
      segmentCb = cb
    },

    reset() {
      speaking = false
      silenceMs = 0
      collected = []
      collectedSamples = 0
    }
  }
}
