/**
 * Tiny pub/sub for live audio meter values.
 *
 * Meters must update at the capture cadence (50 ms) to look smooth, but pushing
 * that through React state re-renders components 20×/s. Instead, capture
 * callbacks publish here and meter components paint bars via direct DOM style
 * writes — zero React involvement on the hot path.
 */
export interface MeterSnapshot {
  /** Analyser peak 0–1 (main pipeline) or scaled RMS 0–1 (test transcriber) */
  inputLevel: number
  /** Last PCM frame RMS 0–1 */
  pcmRms: number
}

let latest: MeterSnapshot = { inputLevel: 0, pcmRms: 0 }
const listeners = new Set<(snapshot: MeterSnapshot) => void>()

export function publishMeter(snapshot: MeterSnapshot): void {
  latest = snapshot
  listeners.forEach((l) => l(latest))
}

export function getLatestMeter(): MeterSnapshot {
  return latest
}

/** Subscribes and immediately paints the latest snapshot. Returns unsubscribe. */
export function subscribeMeter(listener: (snapshot: MeterSnapshot) => void): () => void {
  listeners.add(listener)
  listener(latest)
  return () => {
    listeners.delete(listener)
  }
}
