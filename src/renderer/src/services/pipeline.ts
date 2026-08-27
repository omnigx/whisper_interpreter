/**
 * Audio / STT / LLM pipeline.
 * Architecture:
 *   Mic → Web Audio API → Silero-VAD → 16kHz PCM mono
 *   → WebSocket STT (cloud | local) → context buffer → Gemini/DeepSeek
 */

export type {
  AudioCaptureHandle,
  AudioCaptureOptions,
  AudioLevelSnapshot
} from './audioCapture'

export {
  createAudioCapture,
  createEnergyVad,
  listAudioInputDevices
} from './audioCapture'

export { createSttClient } from './stt'
export type { SttClient } from './stt'

export { createContextBuffer } from './contextBuffer'
export type { ContextBufferHandle } from './contextBuffer'

export {
  SemanticTextBuffer,
  isMeaningfulText
} from './semanticChunker'
export type {
  SemanticFlushEvent,
  SemanticFlushReason,
  SemanticChunkerOptions
} from './semanticChunker'

export { createLlmClient, createOpenAiCompatibleClient } from './llm'
export type { LlmClient } from './llm'

export type VadEngine = 'silero' | 'energy'

export interface PcmPacket {
  /** Int16 little-endian PCM at 16 kHz mono */
  samples: Int16Array
  sampleRate: 16000
  timestamp: number
}

export interface VadSegment {
  startMs: number
  endMs: number
  pcm: Int16Array
  reason: 'silence' | 'max-sentence' | 'manual'
}

export interface SttPartialResult {
  text: string
  isFinal: boolean
  utteranceId: string
}

export interface SileroVadHandle {
  pushPcm: (packet: PcmPacket) => void
  setMaxSentenceMs: (ms: number) => void
  setOnSegment?: (cb: (seg: VadSegment) => void) => void
  reset: () => void
  dispose?: () => void
}

export type SttBackend = 'cloud' | 'local'
