import { useState, useRef } from 'react'
import { AUDIO_INPUT_SOURCE_OPTIONS, type AudioInputSource } from '@shared/types'
import { useAppStore } from '../stores/appStore'
import { useClickOutside } from '../hooks/useClickOutside'

/**
 * Header flyout for the STT capture source — same pattern as recording /
 * engine settings. Online vs offline is decided BEFORE a meeting starts, so
 * this is a low-frequency preflight control, not toolbar furniture.
 */
export function HeaderInputSource({
  onInputSource
}: {
  onInputSource: (mode: AudioInputSource) => void
}): React.JSX.Element {
  const inputSource = useAppStore(
    (s) => s.settings.audio.inputSource ?? 'mic'
  )
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useClickOutside(rootRef, open, () => setOpen(false))

  // Accent while in meeting mode so the state is visible at a glance
  const active = inputSource !== 'mic'
  const activeLabel =
    AUDIO_INPUT_SOURCE_OPTIONS.find((o) => o.value === inputSource)?.label ?? '麦克风'

  return (
    <div
      ref={rootRef}
      className="settings-wrapper relative"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <button
        type="button"
        aria-label="输入源设置"
        aria-expanded={open}
        title={`输入源：${activeLabel}${
          active ? '（会议模式中）' : ''
        } · 点击选择麦克风 / 系统声音环回`}
        className={`flex h-8 w-8 items-center justify-center rounded border transition ${
          active
            ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
            : 'border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)]'
        }`}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onClick={() => setOpen((v) => !v)}
      >
        <MicLineIcon />
      </button>

      {open && (
        <div
          className="settings-panel absolute right-0 z-50 w-72 rounded border border-[var(--border)] bg-[var(--bg-panel)] p-3 shadow-xl"
          style={
            {
              WebkitAppRegion: 'no-drag',
              top: '100%'
            } as React.CSSProperties
          }
          onMouseDown={(e) => e.stopPropagation()}
        >
          <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
            输入源
          </p>

          <div className="flex flex-col gap-1.5">
            {AUDIO_INPUT_SOURCE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                aria-pressed={inputSource === opt.value}
                title={opt.hint}
                onClick={() => {
                  onInputSource(opt.value)
                  setOpen(false)
                }}
                className={`flex flex-col items-start rounded border px-2.5 py-2 text-left transition ${
                  inputSource === opt.value
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--border)] hover:border-[var(--accent)]/60'
                }`}
              >
                <span
                  className={`text-xs font-medium ${
                    inputSource === opt.value
                      ? 'text-[var(--accent)]'
                      : 'text-[var(--text)]'
                  }`}
                >
                  {opt.label}
                  {inputSource === opt.value ? ' ✓' : ''}
                </span>
                <span className="mt-0.5 text-[10px] leading-snug text-[var(--text-muted)]">
                  {opt.hint}
                </span>
              </button>
            ))}
          </div>

          <p className="mt-2 text-[10px] leading-snug text-[var(--text-muted)]/70">
            线上会议选「系统声音」：环回采集系统播放音频，免驱动、会议软件无感；
            监听中切换即时生效。
          </p>
        </div>
      )}
    </div>
  )
}

function MicLineIcon(): React.JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4" />
    </svg>
  )
}
