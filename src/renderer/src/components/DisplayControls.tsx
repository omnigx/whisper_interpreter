import { DEFAULT_SETTINGS } from '@shared/types'
import { useAppStore } from '../stores/appStore'
import {
  CHINESE_FONT_PRESETS,
  WESTERN_FONT_PRESETS
} from '../utils/contentFonts'

export function DisplayControls({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const display = useAppStore((s) => s.settings.display)
  const setDisplay = useAppStore((s) => s.setDisplay)
  const lineHeight = display.lineHeight ?? 1

  return (
    <div className={`flex flex-wrap items-center gap-3 ${compact ? 'text-xs' : 'text-sm'}`}>
      <label className="flex items-center gap-1.5 text-[var(--text-muted)]">
        中文
        <select
          className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)]"
          value={display.chineseFont}
          onChange={(e) => setDisplay({ chineseFont: e.target.value })}
        >
          {CHINESE_FONT_PRESETS.map((f) => (
            <option key={f.label} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1.5 text-[var(--text-muted)]">
        西文
        <select
          className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text)]"
          value={display.westernFont}
          onChange={(e) => setDisplay({ westernFont: e.target.value })}
        >
          {WESTERN_FONT_PRESETS.map((f) => (
            <option key={f.label} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1.5 text-[var(--text-muted)]">
        字号
        <input
          type="range"
          min={12}
          max={36}
          step={1}
          value={display.fontSize}
          onChange={(e) => setDisplay({ fontSize: Number(e.target.value) })}
          className="w-20 accent-[var(--accent)]"
        />
        <span className="w-8 tabular-nums text-[var(--text)]">{display.fontSize}</span>
      </label>

      <label className="flex items-center gap-1.5 text-[var(--text-muted)]">
        行距
        <input
          type="range"
          min={1}
          max={2.5}
          step={0.1}
          value={lineHeight}
          onChange={(e) =>
            setDisplay({ lineHeight: Number(Number(e.target.value).toFixed(1)) })
          }
          className="w-20 accent-[var(--accent)]"
        />
        <span className="w-10 tabular-nums text-[var(--text)]">{lineHeight.toFixed(1)}x</span>
      </label>

      <label className="flex items-center gap-1.5 text-[var(--text-muted)]">
        缩放
        <input
          type="range"
          min={0.8}
          max={1.6}
          step={0.05}
          value={display.zoomScale}
          onChange={(e) => setDisplay({ zoomScale: Number(e.target.value) })}
          className="w-20 accent-[var(--accent)]"
        />
        <span className="w-10 tabular-nums text-[var(--text)]">
          {Math.round(display.zoomScale * 100)}%
        </span>
      </label>

      <button
        type="button"
        className="rounded border border-[var(--border)] px-2 py-1 text-[var(--text-muted)] hover:text-[var(--text)]"
        onClick={() => setDisplay({ ...DEFAULT_SETTINGS.display })}
      >
        默认
      </button>
    </div>
  )
}
