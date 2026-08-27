import { useEffect, useMemo, useRef, useState } from 'react'
import type { SubtitleMirrorState } from '@shared/subtitleSync'
import {
  DEFAULT_CHINESE_FONT,
  DEFAULT_WESTERN_FONT
} from '@shared/subtitleSync'
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
}

const STORAGE_KEY = 'whisper-subtitle-prefs'
const MIN_FONT = 12
const MAX_FONT = 36

const DEFAULT_PREFS: SubtitleLocalPrefs = {
  fontSize: 16,
  lineHeight: 1,
  backgroundOpacity: 60
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
      )
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

  useClickOutside(settingsRootRef, settingsOpen, () => setSettingsOpen(false))

  useEffect(() => {
    document.body.classList.add('subtitle-body')
    return () => document.body.classList.remove('subtitle-body')
  }, [])

  useEffect(() => {
    savePrefs(prefs)
  }, [prefs])

  useEffect(() => {
    window.whisperApi?.setSubtitleLocked?.(isLocked)
  }, [isLocked])

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

  const toggleLock = (): void => {
    setIsLocked((v) => !v)
  }

  const chromeForceVisible = settingsOpen || isLocked

  return (
    <div
      className="lyric-window group relative flex h-screen w-full select-none flex-col overflow-hidden"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        backgroundColor: `rgba(0, 0, 0, ${prefs.backgroundOpacity / 100})`
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

      {/* 右上角按钮组 (沉浸式悬浮层) */}
      <div
        className={`no-drag absolute right-2 top-2 z-[9999] flex items-center gap-2 transition-opacity duration-300 ${
          chromeForceVisible
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
        }`}
        style={{ WebkitAppRegion: 'no-drag' }}
      >
        <span
          className={`inline-flex h-1.5 w-1.5 shrink-0 rounded-full ${
            isListening ? 'bg-emerald-400' : 'bg-slate-500'
          }`}
        />

        <button
          type="button"
          aria-label={isLocked ? '解锁窗口' : '锁定窗口'}
          aria-pressed={isLocked}
          title={isLocked ? '解锁（可拖动/调整大小）' : '锁定（禁止拖动与调整大小）'}
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
              className="settings-panel absolute right-0 z-40 w-56 rounded border border-[var(--border)] bg-[var(--bg-panel)]/95 p-3 shadow-xl backdrop-blur-sm"
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

              <label className="flex flex-col gap-1 text-[10px] text-[var(--text-muted)]">
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
