import { contextBridge, ipcRenderer } from 'electron'
import type { SubtitleMirrorState } from '../shared/subtitleSync'
import type { SessionLogEntry } from '../shared/sessionLog'
import type { RecordingFormatId } from '../shared/types'

const api = {
  /** Open / close the independent floating subtitle BrowserWindow */
  toggleSubtitleWindow: (isOpen: boolean): Promise<boolean> =>
    ipcRenderer.invoke('subtitle:toggle', isOpen),

  isSubtitleWindowOpen: (): Promise<boolean> => ipcRenderer.invoke('subtitle:is-open'),

  /** Main window → main process → subtitle window */
  pushSubtitleState: (state: SubtitleMirrorState): void => {
    ipcRenderer.send('subtitle:push-state', state)
  },

  onSubtitleState: (callback: (state: SubtitleMirrorState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: SubtitleMirrorState): void => {
      callback(state)
    }
    ipcRenderer.on('subtitle:state', handler)
    return () => ipcRenderer.removeListener('subtitle:state', handler)
  },

  onSubtitleWindowOpened: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('subtitle-window-opened', handler)
    return () => ipcRenderer.removeListener('subtitle-window-opened', handler)
  },

  onSubtitleWindowClosed: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('subtitle-window-closed', handler)
    return () => ipcRenderer.removeListener('subtitle-window-closed', handler)
  },

  onSubtitleWindowState: (callback: (isOpen: boolean) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, isOpen: boolean): void => {
      callback(isOpen)
    }
    ipcRenderer.on('subtitle-window-state', handler)
    return () => ipcRenderer.removeListener('subtitle-window-state', handler)
  },

  minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  maximizeToggle: (): Promise<boolean> => ipcRenderer.invoke('window:maximize-toggle'),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
  onMaximizedChanged: (callback: (maximized: boolean) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, maximized: boolean): void => {
      callback(maximized)
    }
    ipcRenderer.on('window:maximized-changed', handler)
    return () => ipcRenderer.removeListener('window:maximized-changed', handler)
  },
  close: (): Promise<void> => ipcRenderer.invoke('window:close'),

  /** Write text to system clipboard (main process — reliable under contextIsolation) */
  writeClipboardText: (text: string): Promise<void> =>
    ipcRenderer.invoke('clipboard:write-text', text),

  /** OS-backed encrypted API key vault (Electron safeStorage) */
  saveApiKey: (
    provider: string,
    key: string
  ): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('save-api-key', provider, key),

  getApiKey: (provider: string): Promise<string | null> =>
    ipcRenderer.invoke('get-api-key', provider),

  isApiKeyEncryptionAvailable: (): Promise<boolean> =>
    ipcRenderer.invoke('is-api-key-encryption-available'),

  /**
   * Lock / unlock subtitle window chrome.
   * Locked = fixed size + full mouse click-through (main process toggles
   * setResizable and setIgnoreMouseEvents); the top-right hotspot in the
   * subtitle window temporarily lifts click-through so buttons stay usable.
   */
  setSubtitleLocked: (isLocked: boolean): void => {
    ipcRenderer.send('set-window-locked', Boolean(isLocked))
  },

  /** Apply a placement/height preset to the satellite subtitle window. */
  setSubtitleGeometry: (position: string, height: string): void => {
    ipcRenderer.send('subtitle:set-geometry', position, height)
  },

  /** Subtitle window screen placement: enumerate displays (follow / fixed). */
  listSubtitleDisplays: (): Promise<
    Array<{ id: number; label: string; primary: boolean }>
  > => ipcRenderer.invoke('subtitle:displays'),

  /** Fired after persisting a new subtitle screen config — re-place now. */
  notifySubtitleScreenConfigChanged: (): void => {
    ipcRenderer.send('subtitle:screen-config-changed')
  },

  /** Subtitle-window hotspot: temporarily lift / restore click-through while locked. */
  setSubtitleClickThrough: (ignore: boolean): void => {
    ipcRenderer.send('subtitle:set-click-through', Boolean(ignore))
  },

  /** Fire-and-forget JSONL session log (main process queue) */
  appendSessionLog: (entry: SessionLogEntry): void => {
    ipcRenderer.send('session-log:append', entry)
  },

  /**
   * Local STT backend launcher: reuse a running instance (port probe) or
   * spawn the engine and wait until its WebSocket port accepts connections.
   */
  ensureSttEngine: (
    engine: string,
    timeoutMs?: number
  ): Promise<{ ok: boolean; alreadyRunning?: boolean; waitedMs?: number; error?: string }> =>
    ipcRenderer.invoke('stt-launcher:ensure', engine, timeoutMs),

  /** Stop engine processes this app spawned, except `keep` (VRAM hygiene). */
  stopOtherSttEngines: (keep: string): Promise<void> =>
    ipcRenderer.invoke('stt-launcher:stop-others', keep),

  /** Port probe only — engine running? (never spawns). */
  getSttEngineStatus: (
    engine: string
  ): Promise<{ ok: boolean; running: boolean; port?: number; error?: string }> =>
    ipcRenderer.invoke('stt-launcher:status', engine),

  /** Kill engines this app spawned (user-started .bat instances stay). */
  stopSttEngines: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('stt-launcher:stop'),

  /** Start a new STT/LLM JSONL pair (called when a listening session begins) */
  rotateSessionLog: (): void => {
    ipcRenderer.send('session-log:rotate')
  },

  listSessionLogs: (): Promise<
    Array<{ name: string; size: number; mtimeMs: number }>
  > => ipcRenderer.invoke('session-log:list'),

  readSessionLog: (
    name: string
  ): Promise<{ ok: boolean; content?: string; error?: string }> =>
    ipcRenderer.invoke('session-log:read', name),

  clearSessionLogs: (): Promise<{
    ok: boolean
    removed: number
    error?: string
  }> => ipcRenderer.invoke('session-log:clear'),

  openSessionLogsDir: (): Promise<{
    ok: boolean
    error?: string
    path?: string
  }> => ipcRenderer.invoke('session-log:open-dir'),

  listRecordings: (): Promise<
    Array<{
      name: string
      size: number
      mtimeMs: number
      birthtimeMs: number
      ext: string
      durationSec?: number
    }>
  > => ipcRenderer.invoke('recordings:list'),

  openRecordingsDir: (): Promise<{
    ok: boolean
    error?: string
    path?: string
  }> => ipcRenderer.invoke('recordings:open-dir'),

  startSyncRecording: (
    format: RecordingFormatId
  ): Promise<{ ok: boolean; error?: string; recording_file?: string }> =>
    ipcRenderer.invoke('sync-recording:start', format),

  /** Int16 LE PCM chunk — non-blocking send */
  appendRecordingPcm: (pcm: ArrayBuffer | Uint8Array): void => {
    ipcRenderer.send('sync-recording:pcm', pcm)
  },

  stopSyncRecording: (): Promise<{
    ok: boolean
    path?: string
    error?: string
  }> => ipcRenderer.invoke('sync-recording:stop'),

  getAppConfig: (): Promise<{
    recording_dir: string
    recording_format: '.wav' | '.mp3 320k' | '.flac'
    subtitle_screen_mode: 'follow' | 'fixed'
    subtitle_screen_id: number | null
  }> => ipcRenderer.invoke('app-config:get'),

  setAppConfig: (
    partial: Partial<{
      recording_dir: string
      recording_format: '.wav' | '.mp3 320k' | '.flac'
      subtitle_screen_mode: 'follow' | 'fixed'
      subtitle_screen_id: number | null
    }>
  ): Promise<{
    recording_dir: string
    recording_format: '.wav' | '.mp3 320k' | '.flac'
    subtitle_screen_mode: 'follow' | 'fixed'
    subtitle_screen_id: number | null
  }> => ipcRenderer.invoke('app-config:set', partial),

  pickRecordingDir: (): Promise<string | null> =>
    ipcRenderer.invoke('app-config:pick-recording-dir'),

  // Back-compat aliases
  setSubtitleMode: (isOpen: boolean): Promise<boolean> =>
    ipcRenderer.invoke('subtitle:toggle', isOpen),
  getSubtitleMode: (): Promise<boolean> => ipcRenderer.invoke('subtitle:is-open'),
  openSubtitleWindow: (): Promise<boolean> => ipcRenderer.invoke('window:open-subtitle'),
  closeSubtitleWindow: (): Promise<boolean> => ipcRenderer.invoke('window:close-subtitle'),
  openFullWindow: (): Promise<boolean> => ipcRenderer.invoke('window:open-full'),
  onSubtitleModeChanged: (callback: (isOpen: boolean) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, isOpen: boolean): void => {
      callback(isOpen)
    }
    ipcRenderer.on('subtitle-window-state', handler)
    return () => ipcRenderer.removeListener('subtitle-window-state', handler)
  }
}

contextBridge.exposeInMainWorld('whisperApi', api)

export type WhisperApi = typeof api
