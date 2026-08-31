/**
 * Time-based emit throttle for LLM streaming chunks.
 *
 * Raw SSE deltas can arrive at 100+ Hz for fast local models; each store write
 * re-renders the transcript panes and (when open) mirrors a full snapshot to the
 * subtitle window. Coalescing to ~12 Hz is visually identical and cuts that cost
 * by an order of magnitude. The final text is always flushed by the caller.
 */
export function createThrottledEmitter(minIntervalMs = 80): {
  emit: (fn: () => void) => void
  reset: () => void
} {
  let last = 0
  return {
    emit(fn) {
      const now = performance.now()
      if (now - last >= minIntervalMs) {
        last = now
        fn()
      }
    },
    reset() {
      last = 0
    }
  }
}
