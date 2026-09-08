/**
 * One JSONL line written under logs/.
 *
 * Field policy: timestamp/module/model_name/content are always present;
 * everything else is optional and only written when meaningful, so old files
 * and old parsers keep working as fields get added.
 */
export interface SessionLogEntry {
  timestamp: string
  module: 'STT' | 'LLM' | 'VAD' | 'SYS' | string
  model_name: string
  content: string
  /** Total request→completion time (LLM: full stream; STT: flush→final text) */
  latency?: number
  /** LLM: the source sentence that produced `content` */
  source_text?: string
  /** LLM: time until the first streamed token (perceived responsiveness) */
  first_token_ms?: number
  /** LLM: actual translation direction used ('en-zh' | 'zh-en') */
  direction?: string
  /** LLM: request failed — content carries the error/partial text */
  failed?: boolean
  /** LLM: output echoed the source verbatim and was discarded */
  echo_intercepted?: boolean
  /** VAD: segment audio length; STT: utterance audio length */
  duration_ms?: number
  /** VAD: what ended the segment ('silence' | 'max-sentence' | 'manual') */
  reason?: string
  /** SYS session-start snapshot: current sentence-break pause setting */
  vad_silence_ms?: number
  /** SYS session-start snapshot: hard segment cap */
  max_sentence_ms?: number
  /** SYS session-start: paired recording file name (logs ↔ audio alignment) */
  recording_file?: string
  /** SYS session-start: capture device label (WER environment context) */
  input_device?: string
  /** SYS session-start: pipeline capture rate (Chromium resamples internally) */
  sample_rate_hz?: number
}
