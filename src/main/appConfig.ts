import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { RecordingFormatId } from '../shared/types'

/** Values persisted in project-root config.json */
export interface AppConfigFile {
  recording_dir: string
  recording_format: '.wav' | '.mp3 320k' | '.flac'
}

const DEFAULT_CONFIG: AppConfigFile = {
  recording_dir: 'recordings',
  recording_format: '.wav'
}

function projectRoot(): string {
  if (!app.isPackaged) return process.cwd()
  return app.getPath('userData')
}

function configPath(): string {
  return path.join(projectRoot(), 'config.json')
}

function normalizeFormat(
  raw: unknown
): AppConfigFile['recording_format'] {
  const s = String(raw ?? '')
  if (s === '.mp3 320k' || s === 'mp3-320k' || s === '.mp3 192k' || s === 'mp3-192k') {
    return '.mp3 320k'
  }
  if (s === '.flac' || s === 'flac') return '.flac'
  return '.wav'
}

export function formatLabelToId(
  label: AppConfigFile['recording_format'] | string
): RecordingFormatId {
  if (label === '.mp3 320k' || label === 'mp3-320k') return 'mp3-320k'
  if (label === '.flac' || label === 'flac') return 'flac'
  return 'wav'
}

export function formatIdToLabel(
  id: RecordingFormatId
): AppConfigFile['recording_format'] {
  if (id === 'mp3-320k' || id === 'mp3-192k') return '.mp3 320k'
  if (id === 'flac') return '.flac'
  return '.wav'
}

let cached: AppConfigFile | null = null

export function loadAppConfig(): AppConfigFile {
  if (cached) return { ...cached }
  const file = configPath()
  try {
    if (!fs.existsSync(file)) {
      ensureDir(path.dirname(file))
      fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8')
      cached = { ...DEFAULT_CONFIG }
      return { ...cached }
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AppConfigFile>
    cached = {
      recording_dir:
        typeof raw.recording_dir === 'string' && raw.recording_dir.trim()
          ? raw.recording_dir.trim()
          : DEFAULT_CONFIG.recording_dir,
      recording_format: normalizeFormat(raw.recording_format)
    }
    return { ...cached }
  } catch (e) {
    console.error('[app-config] load failed, using defaults', e)
    cached = { ...DEFAULT_CONFIG }
    return { ...cached }
  }
}

export function saveAppConfig(partial: Partial<AppConfigFile>): AppConfigFile {
  const prev = loadAppConfig()
  const next: AppConfigFile = {
    recording_dir:
      typeof partial.recording_dir === 'string' && partial.recording_dir.trim()
        ? partial.recording_dir.trim()
        : prev.recording_dir,
    recording_format:
      partial.recording_format !== undefined
        ? normalizeFormat(partial.recording_format)
        : prev.recording_format
  }
  ensureDir(path.dirname(configPath()))
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8')
  cached = next
  return { ...next }
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

/** Absolute recording output directory; creates if missing. */
export function resolveRecordingDir(): string {
  const cfg = loadAppConfig()
  const raw = cfg.recording_dir || 'recordings'
  const abs = path.isAbsolute(raw) ? raw : path.join(projectRoot(), raw)
  ensureDir(abs)
  return abs
}

export function getRecordingFormatId(): RecordingFormatId {
  return formatLabelToId(loadAppConfig().recording_format)
}

export function registerAppConfigIpc(): void {
  // Ensure file exists on first boot
  loadAppConfig()

  ipcMain.handle('app-config:get', () => loadAppConfig())

  ipcMain.handle('app-config:set', (_event, partial: unknown) => {
    if (!partial || typeof partial !== 'object') return loadAppConfig()
    return saveAppConfig(partial as Partial<AppConfigFile>)
  })

  ipcMain.handle('app-config:pick-recording-dir', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts: Electron.OpenDialogOptions = {
      title: '选择录音保存目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: resolveRecordingDir()
    }
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || !result.filePaths[0]) return null
    const dir = result.filePaths[0]
    saveAppConfig({ recording_dir: dir })
    return dir
  })
}
