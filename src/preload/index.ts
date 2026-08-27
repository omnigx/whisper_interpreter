import { contextBridge, ipcRenderer } from 'electron'
import type { SubtitleMirrorState } from '../shared/subtitleSync'

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
   * Main process only toggles setResizable; move uses native -webkit-app-region.
   */
  setSubtitleLocked: (isLocked: boolean): void => {
    ipcRenderer.send('set-window-locked', Boolean(isLocked))
  },

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
