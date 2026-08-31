/**
 * AudioWorklet: capture mono float32 frames, downsample to 16 kHz, emit Int16 PCM.
 * Runs on the audio rendering thread — zero per-sample JS array operations here;
 * all buffering uses preallocated typed arrays to avoid GC pauses/glitches.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const opts = (options && options.processorOptions) || {}
    this.targetRate = opts.targetSampleRate || 16000
    this.inputRate = sampleRate
    this.ratio = this.inputRate / this.targetRate
    this._frameSamples = Math.max(320, Math.floor(this.targetRate * 0.02)) // 20ms
    this._frame = new Float32Array(this._frameSamples)
    this._frameFill = 0
    this._dsBuf = new Float32Array(0)
    this._pcm = new Int16Array(this._frameSamples)
  }

  /** Linear-interpolation resample into a reused scratch buffer. */
  _downsample(input) {
    if (Math.abs(this.ratio - 1) < 0.001) {
      return input
    }
    const outLen = Math.floor(input.length / this.ratio)
    if (this._dsBuf.length !== outLen) {
      this._dsBuf = new Float32Array(outLen)
    }
    const out = this._dsBuf
    for (let i = 0; i < outLen; i++) {
      const srcPos = i * this.ratio
      const i0 = Math.floor(srcPos)
      const i1 = Math.min(i0 + 1, input.length - 1)
      const t = srcPos - i0
      out[i] = input[i0] * (1 - t) + input[i1] * t
    }
    return out
  }

  process(inputs) {
    const ch0 = inputs[0] && inputs[0][0]
    if (!ch0 || ch0.length === 0) {
      return true
    }

    const src = this._downsample(ch0)
    let i = 0
    while (i < src.length) {
      const n = Math.min(this._frameSamples - this._frameFill, src.length - i)
      this._frame.set(src.subarray(i, i + n), this._frameFill)
      this._frameFill += n
      i += n
      if (this._frameFill === this._frameSamples) {
        this._emitFrame()
        this._frameFill = 0
      }
    }

    return true
  }

  _emitFrame() {
    const floatFrame = this._frame
    const pcm = this._pcm
    let sum = 0
    for (let i = 0; i < floatFrame.length; i++) {
      const s = Math.max(-1, Math.min(1, floatFrame[i]))
      sum += s * s
      pcm[i] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0
    }
    const rms = Math.sqrt(sum / floatFrame.length)
    this.port.postMessage(
      {
        type: 'pcm',
        samples: pcm,
        sampleRate: this.targetRate,
        rms,
        timestamp: currentTime * 1000
      },
      [pcm.buffer]
    )
    // pcm.buffer was transferred; allocate a fresh one for the next frame
    this._pcm = new Int16Array(this._frameSamples)
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor)
