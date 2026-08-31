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
      : {})
  }
  try {
    window.whisperApi?.appendSessionLog?.(entry)
  } catch {
    /* never break audio / UI */
  }
}
