import { useEffect, useRef, useState } from 'react'
import { DEFAULT_SETTINGS, type DisplaySettings } from '@shared/types'
import { useAppStore } from '../stores/appStore'
import {
  CHINESE_FONT_PRESETS,
  DEFAULT_CHINESE_FONT,
  DEFAULT_WESTERN_FONT,
  WESTERN_FONT_PRESETS
} from '../utils/contentFonts'
import { useClickOutside } from '../hooks/useClickOutside'

const SAVED_FONT_KEY = 'whisper-saved-font-config'

type SavedFontConfig = Pick<
  DisplaySettings,
  'chineseFont' | 'westernFont' | 'fontSize' | 'lineHeight' | 'zoomScale'
>

const WESTERN_VALUES = new Set<string>(WESTERN_FONT_PRESETS.map((p) => p.value))
const CHINESE_VALUES = new Set<string>(CHINESE_FONT_PRESETS.map((p) => p.value))

/** Map legacy / polluted stacks onto pure preset values. */
function sanitizeFontConfig(partial: Partial<SavedFontConfig>): SavedFontConfig {
  let westernFont = String(partial.westernFont ?? DEFAULT_WESTERN_FONT)
  let chineseFont = String(partial.chineseFont ?? DEFAULT_CHINESE_FONT)

  if (!WESTERN_VALUES.has(westernFont)) {
    if (/times\s*new\s*roman/i.test(westernFont)) westernFont = '"Times New Roman"'
    else if (/calibri/i.test(westernFont)) westernFont = 'Calibri'
    else if (/^-apple-system|Segoe UI|BlinkMacSystemFont/i.test(westernFont)) {
      westernFont = DEFAULT_WESTERN_FONT
    } else if (/^Arial$/i.test(westernFont.trim()) || /^Arial,/i.test(westernFont)) {
      westernFont = 'Arial'
    } else {
      westernFont = DEFAULT_WESTERN_FONT
    }
  }

  if (!CHINESE_VALUES.has(chineseFont)) {
    if (/Noto Serif SC|Source Han Serif/i.test(chineseFont)) {
      chineseFont = CHINESE_FONT_PRESETS[1].value
    } else if (/Noto Sans SC|Source Han Sans/i.test(chineseFont)) {
      chineseFont = CHINESE_FONT_PRESETS[2].value
    } else {
      chineseFont = DEFAULT_CHINESE_FONT
    }
  }

  return {
    chineseFont,
    westernFont,
    fontSize: Number(partial.fontSize) || DEFAULT_SETTINGS.display.fontSize,
    lineHeight: Number(partial.lineHeight) || DEFAULT_SETTINGS.display.lineHeight,
    zoomScale: Number(partial.zoomScale) || DEFAULT_SETTINGS.display.zoomScale
  }
}

function loadSavedFontConfig(): SavedFontConfig | null {
  try {
    const raw = localStorage.getItem(SAVED_FONT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SavedFontConfig>
    if (!parsed.chineseFont && !parsed.westernFont) return null
    return sanitizeFontConfig(parsed)
  } catch {
    return null
  }
}

function persistSavedFontConfig(config: SavedFontConfig): void {
  try {
    localStorage.setItem(SAVED_FONT_KEY, JSON.stringify(config))
  } catch {
    /* ignore */
  }
}

function snapshotDisplay(display: DisplaySettings): SavedFontConfig {
  return sanitizeFontConfig({
    chineseFont: display.chineseFont,
    westernFont: display.westernFont,
    fontSize: display.fontSize,
    lineHeight: display.lineHeight,
    zoomScale: display.zoomScale
  })
}

/** Gear + popover: bilingual fonts / size / line-height / zoom + save/restore. */
export function HeaderDisplaySettings(): React.JSX.Element {
  const display = useAppStore((s) => s.settings.display)
  const setDisplay = useAppStore((s) => s.setDisplay)
  const [open, setOpen] = useState(false)
  const [savedFontConfig, setSavedFontConfig] = useState<SavedFontConfig | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const lineHeight = display.lineHeight ?? 1

  useClickOutside(rootRef, open, () => setOpen(false))

  useEffect(() => {
    setSavedFontConfig(loadSavedFontConfig())
    const cleaned = sanitizeFontConfig(display)
    if (
      cleaned.westernFont !== display.westernFont ||
      cleaned.chineseFont !== display.chineseFont
    ) {
      setDisplay({
        westernFont: cleaned.westernFont,
        chineseFont: cleaned.chineseFont
      })
    }
    // one-shot migrate on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSave = (): void => {
    const next = structuredClone(snapshotDisplay(display))
    setSavedFontConfig(next)
    persistSavedFontConfig(next)
  }

  const handleRestore = (): void => {
    if (!savedFontConfig) return
    setDisplay({ ...sanitizeFontConfig(savedFontConfig) })
  }

  const handleDefault = (): void => {
    setDisplay({ ...DEFAULT_SETTINGS.display })
  }

  return (
    <div
      ref={rootRef}
      className="settings-wrapper relative"
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      <button
        type="button"
        aria-label="显示设置"
        aria-expanded={open}
        title="设置（内容区支持 Ctrl+滚轮调字号）"
        className="flex h-8 w-8 items-center justify-center rounded border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)]"
        style={{ WebkitAppRegion: 'no-drag' }}
        onClick={() => setOpen((v) => !v)}
      >
        <GearIcon />
      </button>

      {open && (
        <div
          className="settings-panel absolute right-0 z-50 w-64 rounded border border-[var(--border)] bg-[var(--bg-panel)] p-3 shadow-xl"
          style={{
            WebkitAppRegion: 'no-drag',
            top: 'calc(100% + 6px)'
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
            显示设置
          </p>
          <p className="mb-2 text-[10px] leading-snug text-[var(--text-muted)]/80">
            字体仅作用于源语言 / 目标语言 / 专业术语区域
          </p>

          <label className="mb-2 flex flex-col gap-1 text-[10px] text-[var(--text-muted)]">
            中文字体
            <select
              className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-[11px] text-[var(--text)]"
              value={
                CHINESE_VALUES.has(display.chineseFont)
                  ? display.chineseFont
                  : DEFAULT_CHINESE_FONT
              }
              onChange={(e) => setDisplay({ chineseFont: e.target.value })}
            >
              {CHINESE_FONT_PRESETS.map((f) => (
                <option key={f.label} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>

          <label className="mb-2 flex flex-col gap-1 text-[10px] text-[var(--text-muted)]">
            西文字体
            <select
              className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-[11px] text-[var(--text)]"
              value={
                WESTERN_VALUES.has(display.westernFont)
                  ? display.westernFont
                  : DEFAULT_WESTERN_FONT
              }
              onChange={(e) => setDisplay({ westernFont: e.target.value })}
            >
              {WESTERN_FONT_PRESETS.map((f) => (
                <option key={f.label} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>

          <label className="mb-2 flex flex-col gap-1 text-[10px] text-[var(--text-muted)]">
            字号 {display.fontSize}px
            <input
              type="range"
              min={12}
              max={36}
              step={1}
              value={display.fontSize}
              onChange={(e) => setDisplay({ fontSize: Number(e.target.value) })}
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
                setDisplay({ lineHeight: Number(Number(e.target.value).toFixed(1)) })
              }
              className="w-full accent-[var(--accent)]"
            />
          </label>

          <label className="mb-3 flex flex-col gap-1 text-[10px] text-[var(--text-muted)]">
            缩放 {Math.round(display.zoomScale * 100)}%
            <input
              type="range"
              min={0.8}
              max={1.6}
              step={0.05}
              value={display.zoomScale}
              onChange={(e) => setDisplay({ zoomScale: Number(e.target.value) })}
              className="w-full accent-[var(--accent)]"
            />
          </label>

          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={handleSave}
              className="flex-1 rounded bg-[var(--accent-soft)] px-2 py-1.5 text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--accent)]/25"
            >
              保存
            </button>
            <button
              type="button"
              onClick={handleRestore}
              disabled={!savedFontConfig}
              className="flex-1 rounded border border-[var(--border)] px-2 py-1.5 text-[11px] font-medium text-[var(--text)] hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              恢复
            </button>
            <button
              type="button"
              onClick={handleDefault}
              className="flex-1 rounded border border-[var(--border)] px-2 py-1.5 text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              默认
            </button>
          </div>
        </div>
      )}
    </div>
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
