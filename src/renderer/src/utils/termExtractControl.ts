/**
 * Cross-hook latch so translate can preempt background term extraction
 * (same local LLM — translation always wins).
 */
let abortPending: (() => void) | null = null

export function registerTermExtractAbort(fn: (() => void) | null): void {
  abortPending = fn
}

/** Call when a translation job is about to hit the LLM. */
export function abortPendingTermExtract(): void {
  abortPending?.()
}
