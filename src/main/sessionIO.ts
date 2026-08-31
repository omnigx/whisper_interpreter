import { app, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import type { RecordingFormatId } from '../shared/types'
import type { SessionLogEntry } from '../shared/sessionLog'
import {
  getRecordingFormatId,
  resolveRecordingDir
} from './appConfig'

const SAMPLE_RATE = 16000
const CHANNELS = 1
const BITS = 16

function projectRoot(): string {
  if (!app.isPackaged) return process.cwd()
  return app.getPath('userData')
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function stampPrefix(d = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** ---------- Async dual-track JSONL logger (STT / LLM separate files) ---------- */

/** Stamp of the current listening session; rotate() starts a new file pair */
let logStamp = stampPrefix()
let sttLogPath: string | null = null
let llmLogPath: string | null = null

const sttLogQueue: string[] = []
const llmLogQueue: string[] = []
let sttDraining = false
let llmDraining = false
/** Safety valve if the renderer ever floods us */
const MAX_QUEUED_LOG_LINES = 5000

function logsDir(): string {
  const dir = path.join(projectRoot(), 'logs')
  ensureDir(dir)
  return dir
}

function ensureSttLogFile(): string {
  if (sttLogPath) return sttLogPath
  sttLogPath = path.join(logsDir(), `${logStamp}_log_stt.jsonl`)
  return sttLogPath
}

function ensureLlmLogFile(): string {
  if (llmLogPath) return llmLogPath
  llmLogPath = path.join(logsDir(), `${logStamp}_log_llm.jsonl`)
  return llmLogPath
}

function scheduleLogDrain(kind: 'stt' | 'llm'): void {
  const isStt = kind === 'stt'
  if (isStt ? sttDraining : llmDraining) return
  if (isStt) sttDraining = true
  else llmDraining = true
  setImmediate(async () => {
    const queue = isStt ? sttLogQueue : llmLogQueue
    const file = isStt ? ensureSttLogFile() : ensureLlmLogFile()
    try {
      // Batch everything queued so far into one async append
      const chunk = queue.splice(0, queue.length).join('')
      if (chunk) await fsp.appendFile(file, chunk, 'utf8')
    } catch (e) {
      console.error(`[session-log:${kind}] append failed`, e)
    } finally {
      if (isStt) sttDraining = false
      else llmDraining = false
      if (queue.length > 0) scheduleLogDrain(kind)
    }
  })
}

function enqueueLog(entry: SessionLogEntry): void {
  const line = `${JSON.stringify(entry)}\n`
  const mod = String(entry.module || '').toUpperCase()
  if (mod === 'LLM') {
    if (llmLogQueue.length < MAX_QUEUED_LOG_LINES) llmLogQueue.push(line)
    scheduleLogDrain('llm')
    return
  }
  if (sttLogQueue.length < MAX_QUEUED_LOG_LINES) sttLogQueue.push(line)
  scheduleLogDrain('stt')
}

/** New JSONL pair for the next listening session (same stamp family as the recording). */
function rotateSessionLog(): void {
  logStamp = stampPrefix()
  sttLogPath = null
  llmLogPath = null
}

function listLogFiles(): Array<{ name: string; size: number; mtimeMs: number }> {
  const dir = logsDir()
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl') || n.endsWith('.log'))
      .map((name) => {
        const full = path.join(dir, name)
        const st = fs.statSync(full)
        return { name, size: st.size, mtimeMs: st.mtimeMs }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    return []
  }
}

function readLogFile(name: string): { ok: boolean; content?: string; error?: string } {
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
    return { ok: false, error: 'invalid name' }
  }
  const full = path.join(logsDir(), name)
  try {
    if (!fs.existsSync(full)) return { ok: false, error: 'not found' }
    const content = fs.readFileSync(full, 'utf8')
    const max = 512 * 1024
    return {
      ok: true,
      content: content.length > max ? `${content.slice(0, max)}\n…(截断)` : content
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function clearLogFiles(): { ok: boolean; removed: number; error?: string } {
  const dir = logsDir()
  let removed = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl') && !name.endsWith('.log')) continue
      try {
        fs.unlinkSync(path.join(dir, name))
        removed += 1
      } catch {
        /* skip locked */
      }
    }
    rotateSessionLog()
    return { ok: true, removed }
  } catch (e) {
    return {
      ok: false,
      removed,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

const AUDIO_EXTS = new Set(['.wav', '.mp3', '.flac'])

function listRecordingFiles(): Array<{
  name: string
  size: number
  mtimeMs: number
  birthtimeMs: number
  ext: string
  durationSec?: number
}> {
  const dir = resolveRecordingDir()
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => {
        if (n.startsWith('.')) return false
        const ext = path.extname(n).toLowerCase()
        return AUDIO_EXTS.has(ext)
      })
      .map((name) => {
        const full = path.join(dir, name)
        const st = fs.statSync(full)
        const ext = path.extname(name).toLowerCase()
        let durationSec: number | undefined
        if (ext === '.wav') {
          try {
            durationSec = readWavDurationSec(full)
          } catch {
            durationSec = undefined
          }
        }
        return {
          name,
          size: st.size,
          mtimeMs: st.mtimeMs,
          birthtimeMs: st.birthtimeMs || st.ctimeMs || st.mtimeMs,
          ext,
          ...(durationSec != null ? { durationSec } : {})
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    return []
  }
}

/** Minimal WAV duration from header (PCM / standard fmt chunk). */
function readWavDurationSec(filePath: string): number | undefined {
  const fd = fs.openSync(filePath, 'r')
  try {
    const header = Buffer.alloc(44)
    const n = fs.readSync(fd, header, 0, 44, 0)
    if (n < 44) return undefined
    if (header.toString('ascii', 0, 4) !== 'RIFF') return undefined
    if (header.toString('ascii', 8, 12) !== 'WAVE') return undefined
    const sampleRate = header.readUInt32LE(24)
    const byteRate = header.readUInt32LE(28)
    const dataSize = header.readUInt32LE(40)
    if (!sampleRate || !byteRate) return undefined
    // Prefer byteRate; fall back to dataSize / (sampleRate * blockAlign)
    if (byteRate > 0 && dataSize > 0) return dataSize / byteRate
    const blockAlign = header.readUInt16LE(32)
    if (blockAlign > 0 && dataSize > 0) return dataSize / (sampleRate * blockAlign)
    return undefined
  } finally {
    fs.closeSync(fd)
  }
}

/** ---------- Sync recording: PCM → WriteStream → temp WAV → ffmpeg ---------- */

interface RecState {
  tempPath: string
  /** Async write stream — never blocks the main-process event loop */
  stream: fs.WriteStream
  dataBytes: number
  format: RecordingFormatId
  outDir: string
  converting: boolean
  /** Session stamp captured at record start — final file is named by it */
  startStamp: string
}

let rec: RecState | null = null

function makeWavHeader(dataBytes: number): Buffer {
  const byteRate = (SAMPLE_RATE * CHANNELS * BITS) / 8
  const blockAlign = (CHANNELS * BITS) / 8
  const buf = Buffer.alloc(44)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(CHANNELS, 22)
  buf.writeUInt32LE(SAMPLE_RATE, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(blockAlign, 32)
  buf.writeUInt16LE(BITS, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataBytes, 40)
  return buf
}

/** Patch the RIFF/data sizes after the stream is fully flushed & closed. */
async function patchWavHeader(filePath: string, dataBytes: number): Promise<void> {
  const handle = await fsp.open(filePath, 'r+')
  try {
    await handle.write(makeWavHeader(dataBytes), 0)
  } finally {
    await handle.close()
  }
}

function ffmpegArgs(format: RecordingFormatId, input: string, output: string): string[] {
  switch (format) {
    case 'mp3-192k':
      return ['-y', '-i', input, '-c:a', 'libmp3lame', '-b:a', '192k', output]
    case 'mp3-320k':
      return ['-y', '-i', input, '-c:a', 'libmp3lame', '-b:a', '320k', output]
    case 'flac':
      return ['-y', '-i', input, '-c:a', 'flac', output]
    case 'wav':
    default:
      return ['-y', '-i', input, '-c:a', 'pcm_s16le', output]
  }
}

function formatExt(format: RecordingFormatId): string {
  if (format === 'flac') return 'flac'
  if (format.startsWith('mp3')) return 'mp3'
  return 'wav'
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let err = ''
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString()
    })
    child.on('error', (e) => {
      reject(
        new Error(
          `无法启动 ffmpeg（请确认已安装并加入 PATH）：${e.message}`
        )
      )
    })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 退出码 ${code}: ${err.slice(-400)}`))
    })
  })
}

async function finalizeRecording(
  state: RecState
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const outDir = state.outDir
  ensureDir(outDir)
  // Named by session START stamp so logs (rotated at the same moment) pair up
  const finalName = `${state.startStamp}_recording.${formatExt(state.format)}`
  const finalPath = path.join(outDir, finalName)

  try {
    if (state.format === 'wav') {
      fs.renameSync(state.tempPath, finalPath)
      return { ok: true, path: finalPath }
    }
    await runFfmpeg(ffmpegArgs(state.format, state.tempPath, finalPath))
    try {
      fs.unlinkSync(state.tempPath)
    } catch {
      /* ignore */
    }
    return { ok: true, path: finalPath }
  } catch (e) {
    const fallback = path.join(outDir, `${state.startStamp}_recording_raw.wav`)
    try {
      fs.renameSync(state.tempPath, fallback)
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      path: fallback,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

function startRecording(format?: unknown): { ok: boolean; error?: string } {
  if (rec) {
    return { ok: false, error: 'recording already active' }
  }
  const fmt =
    typeof format === 'string' && format
      ? (format as RecordingFormatId)
      : getRecordingFormatId()
  const outDir = resolveRecordingDir()
  const startStamp = stampPrefix()
  const tempPath = path.join(outDir, `.tmp_${startStamp}_${process.pid}.wav`)
  try {
    const stream = fs.createWriteStream(tempPath, { highWaterMark: 512 * 1024 })
    stream.write(makeWavHeader(0))
    rec = {
      tempPath,
      stream,
      dataBytes: 0,
      format: fmt,
      outDir,
      converting: false,
      startStamp
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function appendPcm(payload: unknown): void {
  if (!rec || rec.converting) return
  let buf: Buffer | null = null
  if (Buffer.isBuffer(payload)) {
    buf = payload
  } else if (payload instanceof ArrayBuffer) {
    buf = Buffer.from(payload)
  } else if (ArrayBuffer.isView(payload)) {
    const v = payload as ArrayBufferView
    buf = Buffer.from(v.buffer, v.byteOffset, v.byteLength)
  }
  if (!buf || buf.length === 0) return
  try {
    // Backpressure at 32 KB/s input is unreachable in practice; fire-and-forget
    rec.stream.write(buf)
    rec.dataBytes += buf.length
  } catch (e) {
    console.error('[sync-recording] pcm write failed', e)
  }
}

async function stopRecording(): Promise<{ ok: boolean; path?: string; error?: string }> {
  const state = rec
  if (!state) return { ok: true }
  if (state.converting) return { ok: false, error: 'already converting' }
  state.converting = true
  rec = null
  try {
    // 'close' always fires (autoClose); 'error' resolves early and the header
    // patch below surfaces the real failure instead of hanging the stop flow.
    await new Promise<void>((resolve) => {
      state.stream.once('close', () => resolve())
      state.stream.once('error', () => resolve())
      state.stream.end()
    })
    await patchWavHeader(state.tempPath, state.dataBytes)
  } catch (e) {
    // Salvage raw data even when the header patch fails
    const fallback = path.join(state.outDir, `${state.startStamp}_recording_raw.wav`)
    try {
      fs.renameSync(state.tempPath, fallback)
    } catch {
      /* ignore */
    }
    return { ok: false, path: fallback, error: e instanceof Error ? e.message : String(e) }
  }
  return finalizeRecording(state)
}

/**
 * Closing the app mid-recording used to leave the temp WAV with a zero-length
 * header (data present but unreadable). Block quit until the file is finalized.
 */
export function registerSessionQuitGuard(): void {
  let finalizing = false
  app.on('before-quit', (event) => {
    if (finalizing || !rec) return
    finalizing = true
    event.preventDefault()
    void stopRecording()
      .catch(() => undefined)
      .finally(() => {
        app.quit()
      })
  })
}

export function registerSessionIoIpc(): void {
  ipcMain.on('session-log:append', (_event, entry: unknown) => {
    if (!entry || typeof entry !== 'object') return
    const e = entry as Partial<SessionLogEntry>
    if (typeof e.content !== 'string') return
    enqueueLog({
      timestamp:
        typeof e.timestamp === 'string' ? e.timestamp : new Date().toISOString(),
      module: typeof e.module === 'string' ? e.module : 'UNKNOWN',
      model_name: typeof e.model_name === 'string' ? e.model_name : '',
      content: e.content,
      ...(typeof e.latency === 'number' && Number.isFinite(e.latency)
        ? { latency: e.latency }
        : {}),
      ...(typeof e.source_text === 'string' && e.source_text
        ? { source_text: e.source_text }
        : {})
    })
  })

  ipcMain.on('session-log:rotate', () => rotateSessionLog())

  ipcMain.handle('sync-recording:start', (_event, format: unknown) =>
    startRecording(format)
  )

  ipcMain.on('sync-recording:pcm', (_event, payload: unknown) => {
    appendPcm(payload)
  })

  ipcMain.handle('sync-recording:stop', () => stopRecording())

  ipcMain.handle('session-log:list', () => listLogFiles())

  ipcMain.handle('session-log:read', (_event, name: unknown) =>
    readLogFile(typeof name === 'string' ? name : '')
  )

  ipcMain.handle('session-log:clear', () => clearLogFiles())

  ipcMain.handle('session-log:open-dir', async () => {
    const dir = logsDir()
    const err = await shell.openPath(dir)
    return { ok: !err, error: err || undefined, path: dir }
  })

  ipcMain.handle('recordings:list', () => listRecordingFiles())

  ipcMain.handle('recordings:open-dir', async () => {
    const dir = resolveRecordingDir()
    const err = await shell.openPath(dir)
    return { ok: !err, error: err || undefined, path: dir }
  })
}
