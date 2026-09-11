import { useEffect, useMemo, useRef, useState } from 'react'
import type { SubtitleMirrorState } from '@shared/subtitleSync'
import {
  DEFAULT_CHINESE_FONT,
  DEFAULT_WESTERN_FONT
} from '@shared/subtitleSync'
import {
  SUBTITLE_POSITION_ORDER,
  isSubtitleHeightPreset,
  isSubtitlePositionPreset,
  type SubtitleHeightPreset,
  type SubtitlePositionPreset
} from '@shared/types'
import { LanguageTag } from '../components/LanguageTag'
import { buildDialogueHistory } from '../utils/dialogueHistory'
import { detectLanguage } from '../utils/detectLanguage'
import { buildContentFontFamily } from '../utils/contentFonts'
import { useClickOutside } from '../hooks/useClickOutside'

interface SubtitleViewProps {
  /** Mirrored state from main window (required in satellite window). */
  state: SubtitleMirrorState
  onClose: () => void
}

interface SubtitleLocalPrefs {
  fontSize: number
  lineHeight: number
  backgroundOpacity: number
  /** Window placement / height presets (applied via main-process setBounds) */
  position: SubtitlePositionPreset
  height: SubtitleHeightPreset
  /** Palette ids — see BG_PRESETS / TEXT_PRESETS */
  bgColor: string
  textColor: string
}

const STORAGE_KEY = 'whisper-subtitle-prefs'
const MIN_FONT = 12
const MAX_FONT = 36

const DEFAULT_PREFS: SubtitleLocalPrefs = {
  fontSize: 16,
  lineHeight: 1,
  backgroundOpacity: 60,
  position: 'bottom-center',
  height: 'standard',
  bgColor: 'black',
  textColor: 'theme'
}

/**
 * Background palette. Dark hues keep the bright text readable even at low
 * opacity (contrast survives blending with the slide beneath); light hues
 * pair with dark text and want high opacity.
 */
const BG_PRESETS = [
  { id: 'black', label: '纯黑', color: '#000000' },
  { id: 'navy', label: '深蓝', color: '#0B1E3D' },
  { id: 'forest', label: '深绿', color: '#0A2E23' },
  { id: 'graphite', label: '深灰', color: '#1F2430' },
  { id: 'amber', label: '淡黄', color: '#FDE68A' },
  { id: 'white', label: '纯白', color: '#F5F7FA' }
] as const

/**
 * Text palette. 'theme' keeps the stock look (near-white source / green
 * target); the rest override every content color uniformly.
 */
const TEXT_PRESETS = [
  { id: 'theme', label: '默认', color: null },
  { id: 'white', label: '纯白', color: '#FFFFFF' },
  { id: 'sky', label: '亮浅蓝', color: '#7DD3FC' },
  { id: 'mint', label: '亮绿', color: '#6EE7B7' },
  { id: 'yellow', label: '亮黄', color: '#FDE047' },
  { id: 'black', label: '黑', color: '#111827' }
] as const

const POSITION_LABELS: Record<SubtitlePositionPreset, string> = {
  'bottom-center': '屏幕中下方',
  'top-center': '顶部极简',
  'left-column': '屏幕左侧竖条',
  'right-column': '屏幕右侧竖条'
}

function bgPresetColor(id: string): string {
  return BG_PRESETS.find((p) => p.id === id)?.color ?? '#000000'
}

function textPresetColor(id: string): string | null {
  return TEXT_PRESETS.find((p) => p.id === id)?.color ?? null
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function loadPrefs(): SubtitleLocalPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const parsed = JSON.parse(raw) as Partial<SubtitleLocalPrefs> & {
      sourceFontSize?: number
      targetFontSize?: number
    }
    const legacyFont =
      Number(parsed.fontSize) ||
      Number(parsed.sourceFontSize) ||
      Number(parsed.targetFontSize) ||
      DEFAULT_PREFS.fontSize
    return {
      fontSize: clamp(legacyFont, MIN_FONT, MAX_FONT),
      lineHeight: clamp(
        Number(parsed.lineHeight) || DEFAULT_PREFS.lineHeight,
        1,
        2.5
      ),
      backgroundOpacity: clamp(
        Number(parsed.backgroundOpacity) ?? DEFAULT_PREFS.backgroundOpacity,
        0,
        100
      ),
      position: isSubtitlePositionPreset(parsed.position)
        ? parsed.position
        : DEFAULT_PREFS.position,
      height: isSubtitleHeightPreset(parsed.height) ? parsed.height : DEFAULT_PREFS.height,
      bgColor: BG_PRESETS.some((p) => p.id === parsed.bgColor)
        ? (parsed.bgColor as string)
        : DEFAULT_PREFS.bgColor,
      textColor: TEXT_PRESETS.some((p) => p.id === parsed.textColor)
        ? (parsed.textColor as string)
        : DEFAULT_PREFS.textColor
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

function savePrefs(prefs: SubtitleLocalPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    /* ignore */
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/**
 * Split-pane floating subtitle: source top / translation bottom.
 * Display-only — data comes from main window via IPC.
 *
 * Locked mode turns the window into a pure overlay: everything passes mouse
 * through except the top-right hotspot (buttons), which temporarily lifts
 * click-through while hovered.
 */
export function SubtitleView({ state, onClose }: SubtitleViewProps): React.JSX.Element {
  const { partialText, transcripts, translations, isListening } = state
  const chineseFont = state.chineseFont || DEFAULT_CHINESE_FONT
  const westernFont = state.westernFont || DEFAULT_WESTERN_FONT
  const combinedFontFamily = buildContentFontFamily(westernFont, chineseFont)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [isLocked, setIsLocked] = useState(false)
  const [prefs, setPrefs] = useState<SubtitleLocalPrefs>(loadPrefs)

  const sourceScrollRef = useRef<HTMLDivElement>(null)
  const targetScrollRef = useRef<HTMLDivElement>(null)
  const sourceEndRef = useRef<HTMLDivElement>(null)
  const targetEndRef = useRef<HTMLDivElement>(null)
  const settingsRootRef = useRef<HTMLDivElement>(null)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  /** Click-through hotspot state: true while the pointer is over the buttons */
  const hotspotActiveRef = useRef(false)

  useClickOutside(settingsRootRef, settingsOpen, () => setSettingsOpen(false))

  useEffect(() => {
    document.body.classList.add('subtitle-body')
    return () => document.body.classList.remove('subtitle-body')
  }, [])

  useEffect(() => {
    savePrefs(prefs)
  }, [prefs])

  // Lock = fixed geometry + mouse click-through (see windows.ts)
  useEffect(() => {
    if (!isLocked) hotspotActiveRef.current = false
    window.whisperApi?.setSubtitleLocked?.(isLocked)
  }, [isLocked])

  // Apply placement preset (also runs on mount → restores saved geometry)
  useEffect(() => {
    window.whisperApi?.setSubtitleGeometry?.(prefs.position, prefs.height)
  }, [prefs.position, prefs.height])

  /** Ctrl + wheel font zoom on both scroll panes (passive: false). */
  useEffect(() => {
    const nodes = [sourceScrollRef.current, targetScrollRef.current].filter(
      (n): n is HTMLDivElement => Boolean(n)
    )
    if (nodes.length === 0) return

    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()
      const cur = prefsRef.current.fontSize
      const next =
        e.deltaY < 0
          ? Math.min(cur + 1, MAX_FONT)
          : Math.max(cur - 1, MIN_FONT)
      if (next === cur) return
      setPrefs((prev) => ({ ...prev, fontSize: next }))
    }

    for (const el of nodes) {
      el.addEventListener('wheel', onWheel, { passive: false })
    }
    return () => {
      for (const el of nodes) {
        el.removeEventListener('wheel', onWheel)
      }
    }
  }, [])

  const patchPrefs = (partial: Partial<SubtitleLocalPrefs>): void => {
    setPrefs((prev) => {
      const next = { ...prev, ...partial }
      next.fontSize = clamp(next.fontSize, MIN_FONT, MAX_FONT)
      next.lineHeight = clamp(Number(next.lineHeight.toFixed(1)), 1, 2.5)
      next.backgroundOpacity = clamp(next.backgroundOpacity, 0, 100)
      return next
    })
  }

  const cyclePosition = (): void => {
    setPrefs((prev) => {
      const idx = SUBTITLE_POSITION_ORDER.indexOf(prev.position)
      const nextPos =
        SUBTITLE_POSITION_ORDER[(idx + 1) % SUBTITLE_POSITION_ORDER.length]!
      // 顶部极简 preset = slim height by definition
      return { ...prev, position: nextPos, height: nextPos === 'top-center' ? 'slim' : prev.height }
    })
  }

  const toggleHeight = (): void => {
    setPrefs((prev) => ({
      ...prev,
      height: prev.height === 'standard' ? 'slim' : 'standard'
    }))
  }

  /**
   * Click-through hotspot: while locked the window ignores the mouse, but
   * events are forwarded — hovering the button strip lifts click-through so
   * the controls stay usable; leaving the strip restores the pure overlay.
   */
  const setHotspotInteractive = (interactive: boolean): void => {
    if (!isLocked || hotspotActiveRef.current === interactive) return
    hotspotActiveRef.current = interactive
    window.whisperApi?.setSubtitleClickThrough?.(!interactive)
  }

  const visible = useMemo(() => {
    const finals = transcripts.filter((t) => t.text.trim())
    const history = buildDialogueHistory(finals, translations)
    const order = new Map(finals.map((t, i) => [t.id, i]))
    return [...history].sort(
      (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
    )
  }, [transcripts, translations])

  useEffect(() => {
    sourceEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    targetEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [transcripts, partialText, translations, visible.length])

  const { fontSize, lineHeight } = prefs
  const textLineStyle = {
    fontFamily: combinedFontFamily,
    fontSize,
    lineHeight
  }
  const itemGapStyle = { marginBottom: `calc(${lineHeight} * 0.6em)` }
  const paneRegionStyle = {
    WebkitAppRegion: 'no-drag' as const,
    pointerEvents: 'auto' as const
  }

  const bgHex = bgPresetColor(prefs.bgColor)
  const textOverride = textPresetColor(prefs.textColor)
  // Uniform text override: cascade through the theme CSS variables
  const themeVars = (
    textOverride
      ? {
          '--text': textOverride,
          '--target': textOverride,
          '--source': textOverride,
          '--text-muted': textOverride
        }
      : {}
  ) as React.CSSProperties

  const toggleLock = (): void => {
    setIsLocked((v) => !v)
  }

  const chromeForceVisible = settingsOpen || isLocked

  const nextPosition =
    SUBTITLE_POSITION_ORDER[
      (SUBTITLE_POSITION_ORDER.indexOf(prefs.position) + 1) % SUBTITLE_POSITION_ORDER.length
    ]!

  // Column mode: the slim/standard toggle rotates its arrows sideways
  const isColumnPosition =
    prefs.position === 'left-column' || prefs.position === 'right-column'

  return (
    <div
      className="lyric-window group relative flex h-screen w-full select-none flex-col overflow-hidden"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        backgroundColor: hexToRgba(bgHex, prefs.backgroundOpacity / 100),
        ...themeVars
      }}
    >
      {/* Full-bleed content — no top padding; overlays may cover text */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Source pane — 50% */}
        <div className="flex min-h-0 flex-col text-left" style={{ flex: 1 }}>
          <div className="header-title shrink-0 px-4 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--source)]">
            源语言转写
          </div>
          <div
            ref={sourceScrollRef}
            className="custom-scrollbar no-drag min-h-0 flex-1 overflow-y-auto px-4 pb-2"
            style={paneRegionStyle}
          >
            {visible.length === 0 && !partialText ? (
              <div className="text-[var(--text-muted)]/70">
                <span style={textLineStyle}>— 等待转写 —</span>
              </div>
            ) : (
              visible.map((pair) =>
                pair.sttText ? (
                  <div key={`s-${pair.id}`} style={itemGapStyle}>
                    <LanguageTag lang={pair.lang ?? detectLanguage(pair.sttText)} />
                    <span className="text-[var(--text)]" style={textLineStyle}>
                      {pair.sttText}
                    </span>
                  </div>
                ) : null
              )
            )}
            {partialText ? (
              <div
                className="rounded bg-sky-500/15 px-2 py-1 text-[var(--text-muted)] italic"
                style={itemGapStyle}
              >
                <LanguageTag lang={detectLanguage(partialText)} />
                <span style={textLineStyle}>{partialText}</span>
              </div>
            ) : null}
            <div ref={sourceEndRef} />
          </div>
        </div>

        <div className="h-px shrink-0 bg-white/20" />

        {/* Target pane — 50% */}
        <div className="flex min-h-0 flex-col text-left" style={{ flex: 1 }}>
          <div className="header-title shrink-0 px-4 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--target)]">
            目标语言翻译
          </div>
          <div
            ref={targetScrollRef}
            className="custom-scrollbar no-drag min-h-0 flex-1 overflow-y-auto px-4 pb-2"
            style={paneRegionStyle}
          >
            {visible.every((p) => !p.translatedText) ? (
              <div className="text-[var(--text-muted)]/70">
                <span style={textLineStyle}>— 等待翻译 —</span>
              </div>
            ) : (
              visible.map((pair) =>
                pair.translatedText ? (
                  <div key={`t-${pair.id}`} style={itemGapStyle}>
                    <LanguageTag lang={pair.lang} />
                    <span className="text-[var(--target)]" style={textLineStyle}>
                      {pair.translatedText}
                    </span>
                  </div>
                ) : null
              )
            )}
            <div ref={targetEndRef} />
          </div>
        </div>
      </div>

      {/* 拖拽导航条 (沉浸式悬浮层) — DOM after content so it paints / hits above */}
      <div
        className={`absolute left-1/2 top-2 z-[9999] -translate-x-1/2 transition-opacity duration-300 ${
          isLocked
            ? 'hidden'
            : `pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 ${
                chromeForceVisible ? 'pointer-events-auto opacity-100' : ''
              }`
        }`}
        title="拖动移动窗口"
      >
        <div
          className="h-1.5 w-16 cursor-grab rounded-full bg-gray-500/50 transition-all hover:bg-gray-400 active:scale-110 active:cursor-grabbing active:bg-gray-200"
          style={{
            WebkitAppRegion: 'drag',
            pointerEvents: 'auto'
          }}
        />
      </div>

      {/* 右上角按钮组 (沉浸式悬浮层)。锁定时整窗鼠标穿越，但悬停本组可临时恢复交互 */}
      <div
        className={`no-drag absolute right-2 top-2 z-[9999] flex items-center gap-2 transition-opacity duration-300 ${
          chromeForceVisible
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
        }`}
        style={{ WebkitAppRegion: 'no-drag' }}
        onMouseEnter={() => setHotspotInteractive(true)}
        onMouseLeave={() => setHotspotInteractive(false)}
      >
        <span
          className={`inline-flex h-1.5 w-1.5 shrink-0 rounded-full ${
            isListening ? 'bg-emerald-400' : 'bg-slate-500'
          }`}
        />

        <button
          type="button"
          aria-label="切换字幕位置"
          title={`字幕位置：${POSITION_LABELS[prefs.position]}（点击切换 → ${POSITION_LABELS[nextPosition]}）`}
          className={`pointer-events-auto flex h-7 w-7 items-center justify-center rounded border bg-[var(--bg-elevated)] ${
            prefs.position === 'bottom-center'
              ? 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)]'
              : 'border-[var(--accent)] text-[var(--accent)]'
          }`}
          style={{ WebkitAppRegion: 'no-drag' }}
          onClick={cyclePosition}
        >
          <PositionIcon position={prefs.position} />
        </button>

        <button
          type="button"
          aria-label={prefs.height === 'slim' ? '切换为标准高度' : '切换为精简高度'}
          aria-pressed={prefs.height === 'slim'}
          title={
            isColumnPosition
              ? prefs.height === 'slim'
                ? '精简（2/3 屏高）· 点击切换为标准（3/4 屏高）'
                : '标准（3/4 屏高）· 点击切换为精简（2/3 屏高）'
              : prefs.height === 'slim'
                ? '精简高度（每栏约 3 行）· 点击切换为标准'
                : '标准高度（每栏约 5 行）· 点击切换为精简'
          }
          className={`pointer-events-auto flex h-7 w-7 items-center justify-center rounded border bg-[var(--bg-elevated)] ${
            prefs.height === 'slim'
              ? 'border-[var(--accent)] text-[var(--accent)]'
              : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)]'
          }`}
          style={{ WebkitAppRegion: 'no-drag' }}
          onClick={toggleHeight}
        >
          <HeightIcon slim={prefs.height === 'slim'} horizontal={isColumnPosition} />
        </button>

        <button
          type="button"
          aria-label={isLocked ? '解锁窗口' : '锁定窗口'}
          aria-pressed={isLocked}
          title={isLocked ? '解锁（可拖动/调整大小）' : '锁定（窗口固定且鼠标穿透，仅按钮可交互）'}
          className={`pointer-events-auto flex h-7 w-7 items-center justify-center rounded border bg-[var(--bg-elevated)] ${
            isLocked
              ? 'border-[var(--accent)] text-[var(--accent)]'
              : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)]'
          }`}
          style={{ WebkitAppRegion: 'no-drag' }}
          onClick={toggleLock}
        >
          <LockIcon locked={isLocked} />
        </button>

        <div
          ref={settingsRootRef}
          className="settings-wrapper relative pointer-events-auto"
          style={{ WebkitAppRegion: 'no-drag' }}
        >
          <button
            type="button"
            aria-label="字幕设置"
            aria-expanded={settingsOpen}
            title="设置（内容区支持 Ctrl+滚轮调字号）"
            className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)]"
            style={{ WebkitAppRegion: 'no-drag' }}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <GearIcon />
          </button>

          {settingsOpen && (
            <div
              className="settings-panel absolute right-0 z-40 w-60 rounded border border-[var(--border)] bg-[var(--bg-panel)]/95 p-3 shadow-xl backdrop-blur-sm"
              style={{
                WebkitAppRegion: 'no-drag',
                top: 'calc(100% + 4px)'
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                字幕设置
              </p>

              <label className="mb-2 flex flex-col gap-1 text-[10px] text-[var(--text-muted)]">
                字号 {prefs.fontSize}px
                <input
                  type="range"
                  min={MIN_FONT}
                  max={MAX_FONT}
                  value={prefs.fontSize}
                  onChange={(e) => patchPrefs({ fontSize: Number(e.target.value) })}
                  className="w-full accent-[var(--accent)]"
                />
              </label>

              <label className="mb-2 flex flex-col gap-1 text-[10px] text-[var(--text-muted)]">
                行距 {lineHeight.toFixed(1)}x
                <input
                  type="range"
                  min={1}
                  max={2.5}
                  step={0.1}
                  value={lineHeight}
                  onChange={(e) =>
                    patchPrefs({
                      lineHeight: Number(Number(e.target.value).toFixed(1))
                    })
                  }
                  className="w-full accent-[var(--accent)]"
                />
              </label>

              <label className="mb-3 flex flex-col gap-1 text-[10px] text-[var(--text-muted)]">
                背景不透明度 {prefs.backgroundOpacity}%
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={prefs.backgroundOpacity}
                  onChange={(e) =>
                    patchPrefs({ backgroundOpacity: Number(e.target.value) })
                  }
                  className="w-full accent-[var(--accent)]"
                />
              </label>

              <div className="mb-3 flex flex-col gap-1.5">
                <span className="text-[10px] text-[var(--text-muted)]">
                  背景色（深色配亮字；淡黄/纯白建议配黑字）
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {BG_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      title={p.label}
                      aria-label={`背景色 ${p.label}`}
                      aria-pressed={prefs.bgColor === p.id}
                      onClick={() => patchPrefs({ bgColor: p.id })}
                      className={`h-5 w-5 rounded border transition ${
                        prefs.bgColor === p.id
                          ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]/60'
                          : 'border-white/30 hover:border-white/70'
                      }`}
                      style={{ backgroundColor: p.color }}
                    />
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] text-[var(--text-muted)]">文字颜色</span>
                <div className="flex flex-wrap gap-1.5">
                  {TEXT_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      title={p.label}
                      aria-label={`文字色 ${p.label}`}
                      aria-pressed={prefs.textColor === p.id}
                      onClick={() => patchPrefs({ textColor: p.id })}
                      className={`h-5 w-5 rounded border transition ${
                        prefs.textColor === p.id
                          ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]/60'
                          : 'border-white/30 hover:border-white/70'
                      }`}
                      style={{
                        backgroundColor: '#111827',
                        ...(p.color ? { color: p.color } : {})
                      }}
                    >
                      {p.color ? (
                        <span className="text-[13px] font-bold leading-none" style={{ color: p.color }}>
                          文
                        </span>
                      ) : (
                        <span
                          className="text-[13px] font-bold leading-none"
                          style={{
                            background:
                              'linear-gradient(90deg, #e8eef6 50%, #86efac 50%)',
                            WebkitBackgroundClip: 'text',
                            backgroundClip: 'text',
                            color: 'transparent'
                          }}
                        >
                          文
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          aria-label="关闭字幕窗口"
          title="关闭"
          className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:border-[var(--danger)] hover:text-[var(--danger)]"
          style={{ WebkitAppRegion: 'no-drag' }}
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  )
}

function LockIcon({ locked }: { locked: boolean }): React.JSX.Element {
  if (locked) {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden
      >
        <path d="M17 8h-1V6a4 4 0 1 0-8 0v2H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2Zm-7-2a2 2 0 1 1 4 0v2h-4V6Zm3 9.7V17a1 1 0 1 1-2 0v-1.3a2 2 0 1 1 2 0Z" />
      </svg>
    )
  }
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.5-2" />
    </svg>
  )
}

/** Monitor with an indicator at the active screen edge. */
function PositionIcon({
  position
}: {
  position: SubtitlePositionPreset
}): React.JSX.Element {
  const indicator: Record<SubtitlePositionPreset, { x: number; y: number }> = {
    'bottom-center': { x: 10.5, y: 15 },
    'top-center': { x: 10.5, y: 6 },
    'left-column': { x: 6, y: 10.5 },
    'right-column': { x: 18, y: 10.5 }
  }
  const { x, y } = indicator[position]
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M8 20h8" />
      <circle cx={x} cy={y} r="2" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * Full-height / slim-height toggle (contract / expand chevrons).
 * Horizontal bars change vertical thickness (↕); columns rotate 90° so the
 * chevrons point along the horizontal axis, matching the column metaphor.
 */
function HeightIcon({
  slim,
  horizontal
}: {
  slim: boolean
  horizontal?: boolean
}): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={horizontal ? 'rotate-90' : undefined}
      aria-hidden
    >
      {/* slim: chevrons fold toward the middle bar; standard: chevrons expand outward */}
      {slim ? (
        <>
          <path d="M6 12h12" />
          <path d="m8 8 4-4 4 4" />
          <path d="m8 16 4 4 4-4" />
        </>
      ) : (
        <>
          <path d="m8 4 4 4 4-4" />
          <path d="m8 20 4-4 4 4" />
        </>
      )}
    </svg>
  )
}

function GearIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
    </svg>
  )
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}
