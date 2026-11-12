import { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, screen, session } from 'electron'
import { execFile } from 'child_process'
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

function loadSubtitleRenderer(win: BrowserWindow, docked = false): void {
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    const base = process.env['ELECTRON_RENDERER_URL'].replace(/\/$/, '')
    win.loadURL(docked ? `${base}/?docked=1#/subtitle` : `${base}/#/subtitle`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      ...(docked ? { query: { docked: '1' } } : {}),
      hash: '/subtitle'
    })
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

// ---------------------------------------------------------------------------
// 停靠窗口（docked）：与悬浮字幕窗同源同内容的不透明可吸附变体。
// DWM 吸附资格＝transparent:false（Windows 不吸附透明窗口）；无边框 +
// thickFrame（默认保留）即可参与 Win+方向 / 拖边吸附。与悬浮窗相互独立，
// 不互锁（双屏场景：投影悬浮 + 本机停靠）。
// ---------------------------------------------------------------------------
let dockedWindow: BrowserWindow | null = null
let dockedLocked = false

/**
 * 停靠窗"玻璃"背景：composition API 的 ACCENT_ENABLE_TRANSPARENTGRADIENT——
 * 无模糊的系统级实时半透明（区别于 acrylic 材质的模糊透视）。非 layered
 * 窗口路径，DWM 吸附资格保留。Electron 未封装该 API，经 PowerShell P/Invoke
 * 单次调用（零新依赖；TranslucentTB 等工具同款路线，未公开但十余年稳定）。
 * 失败静默——窗口退回 backgroundColor 全透明底（rgba 内容层仍完整覆盖）。
 */
const ACCENT_PS = `
using System;
using System.Runtime.InteropServices;
public static class Accent {
  [StructLayout(LayoutKind.Sequential)]
  public struct ACCENTPOLICY { public int State; public uint Flags; public uint Color; public uint Animation; }
  [StructLayout(LayoutKind.Sequential)]
  public struct WINCOMPATTRDATA { public int Attribute; public IntPtr Data; public int Size; }
  [DllImport("user32.dll")]
  public static extern bool SetWindowCompositionAttribute(IntPtr hwnd, ref WINCOMPATTRDATA data);
  public static void Apply(IntPtr hwnd) {
    var pol = new ACCENTPOLICY { State = 3, Flags = 2, Color = 0x00000000, Animation = 0 };
    var dat = new WINCOMPATTRDATA {
      Attribute = 19,
      Data = Marshal.AllocHGlobal(Marshal.SizeOf(pol)),
      Size = Marshal.SizeOf(pol)
    };
    Marshal.StructureToPtr(pol, dat.Data, false);
    SetWindowCompositionAttribute(hwnd, ref dat);
    Marshal.FreeHGlobal(dat.Data);
  }
}`

function applyDockedGlassAccent(win: BrowserWindow): void {
  try {
    const hwndBuf = win.getNativeWindowHandle()
    const hwnd = process.arch === 'x64' ? hwndBuf.readBigUInt64LE(0) : BigInt(hwndBuf.readUInt32LE(0))
    // Add-Type 编译 + 单次调用；约 1-2s 后台完成，不阻塞窗口显示
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
       `Add-Type -TypeDefinition '${ACCENT_PS.replace(/'/g, "''")}'; [Accent]::Apply([IntPtr]::new(${hwnd}))`],
      { windowsHide: true, timeout: 15000 },
      (err) => {
        if (err) console.warn('[docked] glass accent failed (fallback to plain bg):', err.message)
      }
    )
  } catch (e) {
    console.warn('[docked] glass accent setup failed:', e)
  }
}

/** 悬浮字幕窗是否占着中下位（几何判定而非 preset——窗口可被自由拖动） */
function isSubtitleOccupyingBottomCenter(): boolean {
  if (!subtitleWindow || subtitleWindow.isDestroyed()) return false
  const b = subtitleWindow.getBounds()
  const { width, height, x, y } = subtitleTargetDisplay().workArea
  const cx = b.x + b.width / 2
  return (
    cx > x + width * 0.35 &&
    cx < x + width * 0.65 &&
    b.y + b.height > y + height * 0.5
  )
}

/** 停靠窗默认几何：与字幕窗同一套尺寸（75% 宽 × 标准高），两个锚点——
 *  字幕窗占中下位时右缘锚定，否则中下居中（与字幕窗默认位重合不冲突：
 *  两窗独立，用户自行调整）。 */
function dockedBoundsFor(): Electron.Rectangle {
  const { width, height, x, y } = subtitleTargetDisplay().workArea
  const w = subtitleWidth()
  const h = SUBTITLE_HEIGHTS.standard
  const rightAnchored = isSubtitleOccupyingBottomCenter()
  return {
    x: rightAnchored ? x + width - w : x + Math.round((width - w) / 2),
    y: y + height - h - 50,
    width: w,
    height: h
  }
}

/** 吸附几何判定（宽松版，覆盖 Win10 半屏/四分位 + Win11 全部分屏布局比例）：
 *  宽度匹配任一吸附比例（1/6~5/6）且 x 对齐该比例的网格线即可——
 *  用户手动摆到网格位的窗口同样允许锁定（意图一致：位置已定，点穿无害）。 */
function isBoundsSnapped(b: Electron.Rectangle): boolean {
  const { width, x } = subtitleTargetDisplay().workArea
  const T = 14
  for (const frac of [1 / 6, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 5 / 6]) {
    const w = Math.round(width * frac)
    if (Math.abs(b.width - w) > T) continue
    const cols = Math.round(1 / frac)
    for (let k = 0; k <= cols; k++) {
      if (Math.abs(b.x - (x + k * w)) <= T) return true
    }
  }
  // 上下半屏（Win+↑/↓ 全宽）
  if (
    Math.abs(b.width - width) <= T &&
    (Math.abs(b.y - subtitleTargetDisplay().workArea.y) <= T ||
      Math.abs(b.y + b.height - (subtitleTargetDisplay().workArea.y + subtitleTargetDisplay().workArea.height)) <= T)
  )
    return true
  return false
}

export function createDockedWindow(): BrowserWindow {
  if (dockedWindow && !dockedWindow.isDestroyed()) {
    dockedWindow.show()
    dockedWindow.focus()
    notifyMainDockedOpen(true)
    return dockedWindow
  }
  const b = dockedBoundsFor()
  dockedWindow = new BrowserWindow({
    width: b.width,
    height: b.height,
    minWidth: SUBTITLE_MIN.width,
    minHeight: SUBTITLE_MIN.height,
    x: b.x,
    y: b.y,
    show: false,
    frame: false, // 与悬浮窗同观感；thickFrame 默认保留 → 可拖边/Win键吸附
    transparent: false, // ← DWM 吸附资格（透明窗口 Windows 不吸附）
    backgroundColor: '#00000000', // 全透明底：让 Win11 acrylic 材质透出（非 layered，不影响吸附）
    hasShadow: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: false,
    title: 'Whisper Interpreter — Docked',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })

  dockedWindow.setAlwaysOnTop(true, 'screen-saver')
  // 停靠窗无需跨工作区常显（参与 DWM 分屏，由窗口管理器接管层级）
  dockedWindow.setVisibleOnAllWorkspaces(false)

  // Win11 DWM 材质背景已弃用（acrylic 自带模糊，用户要无模糊纯透明）——
  // 改用 composition API 的 TRANSPARENTGRADIENT（见 applyDockedGlassAccent）。

  applyDockedGlassAccent(dockedWindow)

  dockedWindow.on('ready-to-show', () => {
    dockedWindow?.show()
    notifyMainDockedOpen(true)
    // 与字幕窗同机制：让主渲染器推送最新镜像快照
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('docked-window-opened')
    }
  })

  dockedWindow.on('closed', () => {
    dockedWindow = null
    dockedLocked = false
    notifyMainDockedOpen(false)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('docked-window-closed')
    }
  })

  loadSubtitleRenderer(dockedWindow, true)
  return dockedWindow
}

export function closeDockedWindow(): void {
  if (dockedWindow && !dockedWindow.isDestroyed()) {
    dockedWindow.close()
  }
}

export function toggleDockedWindow(isOpen: boolean): boolean {
  if (isOpen) {
    createDockedWindow()
    return true
  }
  closeDockedWindow()
  return false
}

export function isDockedWindowOpen(): boolean {
  return Boolean(dockedWindow && !dockedWindow.isDestroyed())
}

/** 停靠窗锁定：系统级点穿（锁定后无需拖拽，无悬浮窗的 CSS 方案冲突）。
 *  仅吸附态允许锁定——未吸附时窗口还需要手动拖放，点穿会使其失控。
 *  锁定同时冻结几何（resizable=false），解锁恢复 DWM 吸附调整。
 *  返回是否成功（未吸附返回 false 供 UI 提示）。 */
export function setDockedLocked(locked: boolean): boolean {
  if (!dockedWindow || dockedWindow.isDestroyed()) return false
  // 最大化也是 DWM 管理排布，允许锁定
  const arranged = dockedWindow.isMaximized() || isBoundsSnapped(dockedWindow.getBounds())
  if (locked && !arranged) return false
  if (dockedLocked === locked) return true
  dockedLocked = locked
  dockedWindow.setIgnoreMouseEvents(locked, { forward: true })
  dockedWindow.setResizable(!locked)
  return true
}

export function isDockedLocked(): boolean {
  return dockedLocked
}

function notifyMainDockedOpen(isOpen: boolean): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('docked-window-state', isOpen)
  }
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
    // 停停靠窗共享同一条字幕流（相互独立，可同开供双屏）
    if (dockedWindow && !dockedWindow.isDestroyed()) {
      dockedWindow.webContents.send('subtitle:state', state)
    }
  })

  ipcMain.handle('docked:toggle', (_event, isOpen: boolean) => {
    return toggleDockedWindow(Boolean(isOpen))
  })

  ipcMain.handle('docked:is-open', () => isDockedWindowOpen())

  ipcMain.handle('docked:lock', (_event, locked: boolean) => {
    return setDockedLocked(Boolean(locked))
  })

  ipcMain.handle('docked:is-locked', () => isDockedLocked())

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

  /**
   * Locked subtitle = pure overlay: the whole window passes mouse through
   * (events still forwarded so hover/hotspots work). Unlock restores input.
   * 停靠窗共用本通道（按发送者分发）。
   */
  ipcMain.on('subtitle:set-click-through', (event, ignore: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    if (win === subtitleWindow) {
      if (!subtitleLocked) return
    } else if (win === dockedWindow) {
      if (!dockedLocked) return
    } else {
      return
    }
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

    // A pinned display disappearing (unplug) falls back to follow / primary.
    // (screen listeners must register after ready — touching `screen` earlier
    // throws "can't be used before the app 'ready' event".)
    screen.on('display-removed', () => reapplySubtitleGeometry())

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
