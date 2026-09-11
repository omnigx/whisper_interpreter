import { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, screen, session } from 'electron'
import { join } from 'path'
import {
  isSubtitleHeightPreset,
  isSubtitlePositionPreset,
  type SubtitleHeightPreset,
  type SubtitlePositionPreset
} from '../shared/types'
import { loadAppConfig } from './appConfig'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let subtitleWindow: BrowserWindow | null = null
/** Click-through lock state of the satellite subtitle window */
let subtitleLocked = false

const FULL_MIN = { width: 900, height: 560 }
const FULL_DEFAULT = { width: 1280, height: 800 }
/** Width unchanged; height fits ~5 records × 2 panes (~30px/record + chrome). */
const SUBTITLE_MIN = { width: 280, height: 180 }
/** Horizontal preset: slim ≈ 3 lines/pane, standard ≈ 5 lines/pane */
const SUBTITLE_HEIGHTS: Record<SubtitleHeightPreset, number> = { standard: 350, slim: 240 }
/** Horizontal width scales with the display: 75% of the work area, capped */
const SUBTITLE_WIDTH_RATIO = 0.75
const SUBTITLE_WIDTH_MAX = 1600
/** Vertical column preset geometry — slim = old 2/3 span, standard = 3/4 */
const SUBTITLE_COLUMN_WIDTH = 450
const SUBTITLE_COLUMN_HEIGHT_RATIOS: Record<SubtitleHeightPreset, number> = {
  standard: 0.75,
  slim: 0.66
}
const SUBTITLE_EDGE_INSET = 24

function getPreloadPath(): string {
  return join(__dirname, '../preload/index.mjs')
}

function loadMainRenderer(win: BrowserWindow): void {
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function loadSubtitleRenderer(win: BrowserWindow): void {
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    const base = process.env['ELECTRON_RENDERER_URL'].replace(/\/$/, '')
    win.loadURL(`${base}/#/subtitle`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/subtitle' })
  }
}

function grantMediaPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media' || permission === 'mediaKeySystem') {
      callback(true)
      return
    }
    callback(false)
  })

  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'media' || permission === 'mediaKeySystem'
  })

  // System-audio loopback for meeting transcription: the renderer asks for
  // getDisplayMedia({video, audio}); we auto-answer with the primary screen
  // plus 'loopback' (= passive tap of the system output mix — speakers keep
  // playing, no driver, meeting clients are unaware). The renderer stops the
  // video track immediately and keeps only audio.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        if (sources.length === 0) {
          callback({})
          return
        }
        callback({ video: sources[0], audio: 'loopback' })
      })
      .catch(() => callback({}))
  })
}

/** Disable Chromium background throttling before ready. */
export function applyBackgroundKeepaliveSwitches(): void {
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
}

function notifyMainSubtitleOpen(isOpen: boolean): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('subtitle-window-state', isOpen)
  }
}

/** Horizontal subtitle width: 75% of the work area (display-relative). */
function subtitleWidth(): number {
  const { width } = subtitleTargetDisplay().workArea
  return Math.min(SUBTITLE_WIDTH_MAX, Math.round(width * SUBTITLE_WIDTH_RATIO))
}

/**
 * Display the subtitle window should live on: a pinned display id if
 * configured, otherwise whichever display hosts the main window (follow).
 */
function subtitleTargetDisplay(): Electron.Display {
  const cfg = loadAppConfig()
  if (cfg.subtitle_screen_mode === 'fixed' && cfg.subtitle_screen_id != null) {
    const pinned = screen
      .getAllDisplays()
      .find((d) => d.id === cfg.subtitle_screen_id)
    if (pinned) return pinned
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    return screen.getDisplayMatching(mainWindow.getBounds())
  }
  return screen.getPrimaryDisplay()
}

/** Last preset applied — lets follow-mode reapply bounds on display switches. */
let lastSubtitlePreset: { position: SubtitlePositionPreset; height: SubtitleHeightPreset } = {
  position: 'bottom-center',
  height: 'standard'
}

/**
 * Re-place the subtitle window ONLY when it sits on the wrong display:
 * manual drags inside the same display are preserved.
 */
function reapplySubtitleGeometry(): void {
  if (!subtitleWindow || subtitleWindow.isDestroyed()) return
  const target = subtitleTargetDisplay()
  const current = screen.getDisplayMatching(subtitleWindow.getBounds())
  if (current.id === target.id) return
  subtitleWindow.setBounds(
    subtitleBoundsFor(lastSubtitlePreset.position, lastSubtitlePreset.height)
  )
}

/** Compute window bounds for a subtitle placement preset. */
function subtitleBoundsFor(
  position: SubtitlePositionPreset,
  height: SubtitleHeightPreset
): Electron.Rectangle {
  const { width, height: workHeight, x, y } = subtitleTargetDisplay().workArea

  if (position === 'left-column' || position === 'right-column') {
    const w = Math.min(SUBTITLE_COLUMN_WIDTH, Math.floor(width * 0.5))
    const h = Math.round(workHeight * SUBTITLE_COLUMN_HEIGHT_RATIOS[height])
    const px =
      position === 'left-column'
        ? x + SUBTITLE_EDGE_INSET
        : x + width - w - SUBTITLE_EDGE_INSET
    return { x: px, y: y + Math.round((workHeight - h) / 2), width: w, height: h }
  }

  const w = subtitleWidth()
  const h = SUBTITLE_HEIGHTS[height]
  const px = x + Math.round((width - w) / 2)
  const py =
    position === 'top-center'
      ? y + SUBTITLE_EDGE_INSET
      : y + workHeight - h - 50
  return { x: px, y: py, width: w, height: h }
}

function applySubtitleGeometry(
  position: SubtitlePositionPreset,
  height: SubtitleHeightPreset
): void {
  if (!subtitleWindow || subtitleWindow.isDestroyed()) return
  lastSubtitlePreset = { position, height }
  subtitleWindow.setBounds(subtitleBoundsFor(position, height))
}

export function createSubtitleWindow(): BrowserWindow {
  if (subtitleWindow && !subtitleWindow.isDestroyed()) {
    subtitleWindow.show()
    subtitleWindow.focus()
    notifyMainSubtitleOpen(true)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('subtitle-window-opened')
    }
    return subtitleWindow
  }

  const { width, height, x, y } = subtitleTargetDisplay().workArea
  const subWidth = subtitleWidth()
  const subHeight = SUBTITLE_HEIGHTS.standard

  subtitleWindow = new BrowserWindow({
    width: subWidth,
    height: subHeight,
    minWidth: SUBTITLE_MIN.width,
    minHeight: SUBTITLE_MIN.height,
    x: x + Math.round((width - subWidth) / 2),
    y: y + Math.round(height - subHeight - 50),
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    title: 'Whisper Interpreter — Subtitle',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })

  subtitleWindow.setAlwaysOnTop(true, 'screen-saver')
  subtitleWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Never call setIgnoreMouseEvents — it would block native -webkit-app-region drag.

  subtitleWindow.on('ready-to-show', () => {
    subtitleWindow?.show()
    notifyMainSubtitleOpen(true)
    // Ask main renderer to push latest store snapshot
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('subtitle-window-opened')
    }
  })

  subtitleWindow.on('closed', () => {
    subtitleWindow = null
    notifyMainSubtitleOpen(false)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('subtitle-window-closed')
    }
  })

  loadSubtitleRenderer(subtitleWindow)
  return subtitleWindow
}

export function closeSubtitleWindow(): void {
  if (subtitleWindow && !subtitleWindow.isDestroyed()) {
    subtitleWindow.close()
  }
}

export function toggleSubtitleWindow(isOpen: boolean): boolean {
  if (isOpen) {
    createSubtitleWindow()
    return true
  }
  closeSubtitleWindow()
  return false
}

export function isSubtitleWindowOpen(): boolean {
  return Boolean(subtitleWindow && !subtitleWindow.isDestroyed())
}

export function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus()
    return mainWindow
  }

  mainWindow = new BrowserWindow({
    width: FULL_DEFAULT.width,
    height: FULL_DEFAULT.height,
    minWidth: FULL_MIN.width,
    minHeight: FULL_MIN.height,
    show: false,
    frame: false,
    transparent: false,
    hasShadow: true,
    backgroundColor: '#0f1419',
    title: 'Whisper Interpreter',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  const emitMaximized = (): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized-changed', mainWindow.isMaximized())
    }
  }
  mainWindow.on('maximize', emitMaximized)
  mainWindow.on('unmaximize', emitMaximized)

  // Follow mode: drag the main window across displays → the subtitle window
  // hops to the new display (debounced; same-display manual drags are kept).
  let followTimer: NodeJS.Timeout | null = null
  const scheduleSubtitleFollow = (): void => {
    if (followTimer) clearTimeout(followTimer)
    followTimer = setTimeout(() => {
      followTimer = null
      reapplySubtitleGeometry()
    }, 250)
  }
  mainWindow.on('move', scheduleSubtitleFollow)
  mainWindow.on('resize', scheduleSubtitleFollow)

  mainWindow.on('closed', () => {
    if (followTimer) clearTimeout(followTimer)
    mainWindow = null
    // Tear down satellite window with main
    if (subtitleWindow && !subtitleWindow.isDestroyed()) {
      subtitleWindow.close()
    }
    subtitleWindow = null
  })

  loadMainRenderer(mainWindow)
  return mainWindow
}

/** @deprecated alias */
export function createFullWindow(): BrowserWindow {
  return createMainWindow()
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function registerWindowIpc(): void {
  ipcMain.handle('subtitle:toggle', (_event, isOpen: boolean) => {
    return toggleSubtitleWindow(Boolean(isOpen))
  })

  ipcMain.handle('subtitle:is-open', () => isSubtitleWindowOpen())

  /** Main renderer → main process → subtitle renderer (dumb display) */
  ipcMain.on('subtitle:push-state', (_event, state: unknown) => {
    if (subtitleWindow && !subtitleWindow.isDestroyed()) {
      subtitleWindow.webContents.send('subtitle:state', state)
    }
  })

  // Back-compat
  ipcMain.handle('window:open-subtitle', () => toggleSubtitleWindow(true))
  ipcMain.handle('window:close-subtitle', () => {
    toggleSubtitleWindow(false)
    return true
  })
  ipcMain.handle('window:set-subtitle-mode', (_e, isOpen: boolean) =>
    toggleSubtitleWindow(Boolean(isOpen))
  )
  ipcMain.handle('window:get-subtitle-mode', () => isSubtitleWindowOpen())
  ipcMain.handle('window:open-full', () => {
    // Focus main; do not close subtitle (multi-window: both can coexist)
    mainWindow?.show()
    mainWindow?.focus()
    return true
  })

  ipcMain.handle('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.minimize()
  })

  ipcMain.handle('window:maximize-toggle', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    if (win.isMaximized()) {
      win.unmaximize()
      return false
    }
    win.maximize()
    return true
  })

  ipcMain.handle('window:is-maximized', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return Boolean(win?.isMaximized())
  })

  ipcMain.handle('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    // Closing from subtitle should only close subtitle
    if (win === subtitleWindow) {
      closeSubtitleWindow()
      return
    }
    win?.close()
  })

  ipcMain.on('subtitle:set-geometry', (_event, position: unknown, height: unknown) => {
    if (!isSubtitlePositionPreset(position) || !isSubtitleHeightPreset(height)) return
    applySubtitleGeometry(position, height)
  })

  /** Enumerate displays for the 字幕窗口位置 setting (follow / fixed). */
  ipcMain.handle('subtitle:displays', () => {
    const primary = screen.getPrimaryDisplay()
    return screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      label: `显示器 ${i + 1}（${d.bounds.width}×${d.bounds.height}${
        d.id === primary.id ? '，主屏' : ''
      }）`,
      primary: d.id === primary.id
    }))
  })

  /** Fired after the renderer persists a new subtitle screen config. */
  ipcMain.on('subtitle:screen-config-changed', () => reapplySubtitleGeometry())

  // A pinned display disappearing (unplug) falls back to follow / primary.
  screen.on('display-removed', () => reapplySubtitleGeometry())

  /**
   * Locked subtitle = pure overlay: the whole window passes mouse through
   * (events still forwarded so hover/hotspots work). Unlock restores input.
   */
  ipcMain.on('subtitle:set-click-through', (event, ignore: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || win !== subtitleWindow) return
    if (!subtitleLocked) return
    win.setIgnoreMouseEvents(Boolean(ignore), { forward: true })
  })

  ipcMain.on('set-window-locked', (event, isLocked: unknown) => {
    const locked = Boolean(isLocked)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    // Unlock → edge resize allowed; lock → size + (CSS) position locked
    win.setResizable(!locked)
    if (win === subtitleWindow) {
      subtitleLocked = locked
      win.setIgnoreMouseEvents(locked, { forward: true })
    }
  })

  ipcMain.handle('clipboard:write-text', (_event, text: unknown) => {
    clipboard.writeText(typeof text === 'string' ? text : String(text ?? ''))
  })
}

export function setupAppLifecycle(): void {
  app.whenReady().then(() => {
    grantMediaPermissions()
    createMainWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
      } else {
        mainWindow?.show()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
