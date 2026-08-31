import * as ort from 'onnxruntime-web'
import type { PcmPacket, SileroVadHandle, VadEngine, VadSegment } from './pipeline'
import { createEnergyVad } from './audioCapture'

const FRAME_SAMPLES = 512 // Silero v5
const SAMPLE_RATE = 16000

export type { VadEngine }

export interface SileroVadOptions {
  maxSentenceMs?: number
  positiveSpeechThreshold?: number
  negativeSpeechThreshold?: number
  redemptionMs?: number
  minSpeechMs?: number
  onSegment?: (seg: VadSegment) => void
  onSpeechProb?: (p: number) => void
  onEngine?: (engine: VadEngine) => void
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function int16ToFloat32(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] / 32768
  }
  return out
}

function float32ToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    out[i] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0
  }
  return out
}

/** Minimal Silero v5 session (avoids @ricky0123/vad-web CJS/dynamic-require crash in Vite) */
class SileroV5Session {
  private state: ort.Tensor
  private readonly sr: ort.Tensor

  private constructor(
    private session: ort.InferenceSession,
    state: ort.Tensor,
    sr: ort.Tensor
  ) {
    this.state = state
    this.sr = sr
  }

  static async create(modelUrl: string): Promise<SileroV5Session> {
    ort.env.wasm.wasmPaths = `${window.location.origin}/ort/`
    ort.env.wasm.numThreads = 1
    const res = await fetch(modelUrl)
    if (!res.ok) throw new Error(`Failed to fetch Silero model: ${res.status}`)
    const buf = await res.arrayBuffer()
    const session = await ort.InferenceSession.create(buf)
    const state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128])
    const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]))
    return new SileroV5Session(session, state, sr)
  }

  reset(): void {
    this.state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128])
  }

  async process(frame: Float32Array): Promise<number> {
    const input = new ort.Tensor('float32', frame, [1, frame.length])
    const out = await this.session.run({
      input,
      state: this.state,
      sr: this.sr
    })
    const next = out['stateN']
    if (next) this.state = next as ort.Tensor
    const score = (out['output']?.data as Float32Array | undefined)?.[0]
    if (typeof score !== 'number') throw new Error('Invalid Silero output')
    return score
  }

  async release(): Promise<void> {
    await this.session.release()
  }
}

/**
 * Silero-VAD over our 16 kHz PCM stream.
 * Falls back to energy VAD if ONNX/WASM fails.
 */
export async function createSileroVadAsync(
  options: SileroVadOptions = {}
): Promise<SileroVadHandle & { engine: VadEngine; dispose: () => void }> {
  let maxMs = clamp(options.maxSentenceMs ?? 15000, 5000, 30000)
  let onSegment = options.onSegment
  const positive = options.positiveSpeechThreshold ?? 0.5
  let redemptionMs = options.redemptionMs ?? 300
  const minSpeechMs = options.minSpeechMs ?? 250
  void options.negativeSpeechThreshold

  try {
    const model = await SileroV5Session.create(
      `${window.location.origin}/vad/silero_vad_v5.onnx`
    )

    const residual = new Float32Array(FRAME_SAMPLES * 4)
    let residualLen = 0
    const speechFrames: Float32Array[] = []
    let speaking = false
    let speechStartMs = 0
    let silenceMs = 0
    let speechMs = 0
    let queue: Promise<void> = Promise.resolve()
    let maxTimer: ReturnType<typeof setTimeout> | null = null
    let frameErrorLogged = false

    const clearMaxTimer = (): void => {
      if (maxTimer != null) {
        clearTimeout(maxTimer)
        maxTimer = null
      }
    }

    const emit = (reason: VadSegment['reason']): void => {
      const hadFrames = speechFrames.length > 0
      const utteredMs = speechMs
      const total = speechFrames.reduce((n, f) => n + f.length, 0)
      const merged = new Float32Array(total)
      let off = 0
      for (const f of speechFrames) {
        merged.set(f, off)
        off += f.length
      }
      speechFrames.length = 0
      const now = performance.now()
      const wasSpeaking = speaking
      speaking = false
      silenceMs = 0
      speechMs = 0
      clearMaxTimer()

      // Always notify on max-sentence so is_final is forced
      if (reason === 'max-sentence') {
        if (!wasSpeaking && !hadFrames) return
        onSegment?.({
          startMs: speechStartMs,
          endMs: now,
          pcm: float32ToInt16(merged.length > 0 ? merged : new Float32Array(0)),
          reason
        })
        return
      }

      if (!hadFrames || utteredMs < minSpeechMs) return
      onSegment?.({
        startMs: speechStartMs,
        endMs: now,
        pcm: float32ToInt16(merged),
        reason
      })
    }

    const processFrame = (frame: Float32Array): void => {
      queue = queue
        .then(async () => {
          const prob = await model.process(frame)
          options.onSpeechProb?.(prob)
          const frameMs = (FRAME_SAMPLES / SAMPLE_RATE) * 1000

          if (prob >= positive) {
            if (!speaking) {
              speaking = true
              speechStartMs = performance.now()
              speechMs = 0
              silenceMs = 0
              clearMaxTimer()
              maxTimer = setTimeout(() => emit('max-sentence'), maxMs)
            }
            speechFrames.push(frame)
            speechMs += frameMs
            silenceMs = 0
            return
          }

          if (speaking) {
            speechFrames.push(frame)
            // Count silence whenever below positive threshold (not only < negative),
            // otherwise mid-prob noise never settles and final never arrives.
            if (prob < positive) {
              silenceMs += frameMs
              if (silenceMs >= redemptionMs) {
                if (speechMs >= minSpeechMs) emit('silence')
                else {
                  speechFrames.length = 0
                  speaking = false
                  silenceMs = 0
                  speechMs = 0
                  clearMaxTimer()
                }
              }
            } else {
              silenceMs = 0
            }
          }
        })
        .catch((err) => {
          // A single failed frame must not poison the chain — without this
          // catch every later frame is silently skipped and the VAD dies.
          if (!frameErrorLogged) {
            frameErrorLogged = true
            console.error('[VAD] frame processing failed (later errors suppressed)', err)
          }
          model.reset()
        })
    }

    options.onEngine?.('silero')

    return {
      engine: 'silero',
      pushPcm(packet: PcmPacket) {
        const f32 = int16ToFloat32(packet.samples)
        let offset = 0
        while (offset < f32.length) {
          const n = Math.min(FRAME_SAMPLES - residualLen, f32.length - offset)
          residual.set(f32.subarray(offset, offset + n), residualLen)
          residualLen += n
          offset += n
          if (residualLen === FRAME_SAMPLES) {
            // processFrame retains the array in speechFrames — hand it a private
            // copy of ONLY the filled region (bare slice() would copy all 2048)
            processFrame(residual.slice(0, FRAME_SAMPLES))
            residualLen = 0
          }
        }
      },
      setMaxSentenceMs(ms) {
        maxMs = clamp(ms, 5000, 30000)
      },
      setRedemptionMs(ms) {
        redemptionMs = Math.max(100, ms)
      },
      setOnSegment(cb) {
        onSegment = cb
      },
      reset() {
        clearMaxTimer()
        residualLen = 0
        speechFrames.length = 0
        speaking = false
        silenceMs = 0
        speechMs = 0
        model.reset()
      },
      dispose() {
        clearMaxTimer()
        residualLen = 0
        void model.release()
      }
    }
  } catch (err) {
    console.warn('[VAD] Silero load failed, falling back to energy VAD', err)
    options.onEngine?.('energy')
    const energy = createEnergyVad(maxMs, (seg) => onSegment?.(seg))
    return {
      engine: 'energy',
      pushPcm(packet) {
        energy.pushPcm(packet)
      },
      setMaxSentenceMs(ms) {
        maxMs = clamp(ms, 5000, 30000)
        energy.setMaxSentenceMs(maxMs)
      },
      setRedemptionMs(ms) {
        energy.setRedemptionMs?.(Math.max(100, ms))
      },
      setOnSegment(cb) {
        onSegment = cb
        energy.setOnSegment?.(cb)
      },
      reset() {
        energy.reset()
      },
      dispose() {
        energy.reset()
      }
    }
  }
}
