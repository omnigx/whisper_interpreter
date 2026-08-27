/**
 * AudioWorklet: capture mono float32 frames, downsample to 16 kHz, emit Int16 PCM.
 * Runs on the audio rendering thread.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const opts = (options && options.processorOptions) || {}
    this.targetRate = opts.targetSampleRate || 16000
    this.inputRate = sampleRate
    this.ratio = this.inputRate / this.targetRate
    this._residual = []
    this._frameSamples = Math.max(320, Math.floor(this.targetRate * 0.02)) // 20ms
    this._outBuffer = []
  }

  _downsample(input) {
    if (Math.abs(this.ratio - 1) < 0.001) {
      return input
    }
    const outLen = Math.floor(input.length / this.ratio)
    const out = new Float32Array(outLen)
    for (let i = 0; i < outLen; i++) {
      const srcPos = i * this.ratio
      const i0 = Math.floor(srcPos)
      const i1 = Math.min(i0 + 1, input.length - 1)
      const t = srcPos - i0
      out[i] = input[i0] * (1 - t) + input[i1] * t
    }
    return out
  }

  _floatToInt16(floatSamples) {
    const out = new Int16Array(floatSamples.length)
    for (let i = 0; i < floatSamples.length; i++) {
      const s = Math.max(-1, Math.min(1, floatSamples[i]))
      out[i] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0
    }
    return out
  }

  process(inputs) {
    const ch0 = inputs[0] && inputs[0][0]
    if (!ch0 || ch0.length === 0) {
      return true
    }

    const down = this._downsample(ch0)
    for (let i = 0; i < down.length; i++) {
      this._outBuffer.push(down[i])
    }

    while (this._outBuffer.length >= this._frameSamples) {
      const frame = this._outBuffer.splice(0, this._frameSamples)
      const floatFrame = Float32Array.from(frame)
      let sum = 0
      for (let i = 0; i < floatFrame.length; i++) {
        sum += floatFrame[i] * floatFrame[i]
      }
      const rms = Math.sqrt(sum / floatFrame.length)
      const pcm = this._floatToInt16(floatFrame)
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
    }

    return true
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor)
