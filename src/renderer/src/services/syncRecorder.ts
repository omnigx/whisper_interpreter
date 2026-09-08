import type { RecordingFormatId } from '@shared/types'
import { useAppStore } from '../stores/appStore'

/**
 * Tap 16 kHz Int16 PCM and forward to main process for temp-WAV + ffmpeg export.
 * Chunks are batched (~250 ms / 32 KB) so the renderer→main IPC drops from
 * ~50 msg/s to ~4 msg/s during recording. All disk I/O / ffmpeg runs in main.
 * Updates recordingUiStatus for the footer indicator.
 */
let active = false
/** Final file name of the current/latest recording (for log pairing) */
let lastRecordingFile: string | undefined

export function getLastRecordingFile(): string | undefined {
  return lastRecordingFile
}

/** Batched PCM accumulator */
const BATCH_FLUSH_MS = 250
const BATCH_FLUSH_BYTES = 32 * 1024
let batch: Uint8Array[] = []
let batchBytes = 0
let flushTimer: number | null = null

export function isSyncRecordingActive(): boolean {
  return active
}

function flushBatch(): void {
  if (flushTimer != null) {
    window.clearTimeout(flushTimer)
    flushTimer = null
  }
  if (batch.length === 0) return
  const chunks = batch
  batch = []
  batchBytes = 0
  try {
    let payload: ArrayBuffer | Uint8Array
    if (chunks.length === 1) {
      payload = chunks[0]!
    } else {
      const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
      let off = 0
      for (const c of chunks) {
        merged.set(c, off)
        off += c.byteLength
      }
      payload = merged
    }
    window.whisperApi?.appendRecordingPcm?.(payload)
  } catch {
    /* ignore */
  }
}

export async function startSyncRecording(
  format: RecordingFormatId
): Promise<{ ok: boolean; error?: string }> {
  if (active) {
    useAppStore.getState().setRecordingUiStatus('recording')
    return { ok: true }
  }
  const api = window.whisperApi
  if (!api?.startSyncRecording) {
    return { ok: false, error: '录音 API 不可用' }
  }
  const res = await api.startSyncRecording(format)
  if (res?.ok) {
    active = true
    lastRecordingFile = res.recording_file
    useAppStore.getState().setRecordingUiStatus('recording')
  }
  return res ?? { ok: false, error: 'start failed' }
}

export function appendSyncRecordingPcm(samples: Int16Array): void {
  if (!active) return
  try {
    // Worklet frames are exact-size transfers; avoid an extra copy when possible
    const view =
      samples.byteOffset === 0 && samples.byteLength === samples.buffer.byteLength
        ? new Uint8Array(samples.buffer)
        : new Uint8Array(samples.buffer.slice(
            samples.byteOffset,
            samples.byteOffset + samples.byteLength
          ))
    batch.push(view)
    batchBytes += view.byteLength

    if (batchBytes >= BATCH_FLUSH_BYTES) {
      flushBatch()
      return
    }
    if (flushTimer == null) {
      flushTimer = window.setTimeout(flushBatch, BATCH_FLUSH_MS)
    }
  } catch {
    /* ignore */
  }
}

export async function stopSyncRecording(): Promise<{
  ok: boolean
  path?: string
  error?: string
}> {
  if (!active) {
    useAppStore.getState().setRecordingUiStatus('ready')
    return { ok: true }
  }
  active = false
  useAppStore.getState().setRecordingUiStatus('saving')
  // Push the tail of the batch before telling main to finalize
  flushBatch()
  try {
    return (
      (await window.whisperApi?.stopSyncRecording?.()) ?? {
        ok: false,
        error: 'stop failed'
      }
    )
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    useAppStore.getState().setRecordingUiStatus('ready')
  }
}
