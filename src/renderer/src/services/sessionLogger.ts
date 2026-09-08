import type { SessionLogEntry } from '@shared/sessionLog'

/**
 * Non-blocking session logger.
 * Renderer only enqueues via IPC; main process drains a write queue.
 */
export function logSessionEvent(
  partial: Omit<SessionLogEntry, 'timestamp'> & { timestamp?: string }
): void {
  const entry: SessionLogEntry = {
    timestamp: partial.timestamp ?? new Date().toISOString(),
    module: partial.module,
    model_name: partial.model_name,
    content: partial.content,
    ...(typeof partial.latency === 'number' ? { latency: partial.latency } : {}),
    ...(typeof partial.source_text === 'string' && partial.source_text
      ? { source_text: partial.source_text }
      : {}),
    ...(typeof partial.first_token_ms === 'number' && Number.isFinite(partial.first_token_ms)
      ? { first_token_ms: partial.first_token_ms }
      : {}),
    ...(typeof partial.direction === 'string' && partial.direction
      ? { direction: partial.direction }
      : {}),
    ...(partial.failed === true ? { failed: true } : {}),
    ...(partial.echo_intercepted === true ? { echo_intercepted: true } : {}),
    ...(typeof partial.duration_ms === 'number' && Number.isFinite(partial.duration_ms)
      ? { duration_ms: partial.duration_ms }
      : {}),
    ...(typeof partial.reason === 'string' && partial.reason
      ? { reason: partial.reason }
      : {}),
    ...(typeof partial.vad_silence_ms === 'number' && Number.isFinite(partial.vad_silence_ms)
      ? { vad_silence_ms: partial.vad_silence_ms }
      : {}),
    ...(typeof partial.max_sentence_ms === 'number' && Number.isFinite(partial.max_sentence_ms)
      ? { max_sentence_ms: partial.max_sentence_ms }
      : {}),
    ...(typeof partial.recording_file === 'string' && partial.recording_file
      ? { recording_file: partial.recording_file }
      : {}),
    ...(typeof partial.input_device === 'string' && partial.input_device
      ? { input_device: partial.input_device }
      : {}),
    ...(typeof partial.sample_rate_hz === 'number' && Number.isFinite(partial.sample_rate_hz)
      ? { sample_rate_hz: partial.sample_rate_hz }
      : {})
  }
  try {
    window.whisperApi?.appendSessionLog?.(entry)
  } catch {
    /* never break audio / UI */
  }
}
