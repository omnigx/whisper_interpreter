import { useEffect, useState } from 'react'

/** Frameless window chrome — minimize / maximize / close */
export function WindowControls(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.whisperApi?.isMaximized?.().then((v) => {
      if (typeof v === 'boolean') setMaximized(v)
    })
    const unsub = window.whisperApi?.onMaximizedChanged?.((v) => setMaximized(v))
    return () => unsub?.()
  }, [])

  return (
    <div
      className="no-drag ml-1 flex items-center"
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      <button
        type="button"
        title="最小化"
        aria-label="最小化"
        className="flex h-8 w-10 items-center justify-center text-[var(--text-muted)] transition hover:bg-white/10 hover:text-[var(--text)]"
        onClick={() => void window.whisperApi?.minimize?.()}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          <path d="M2 6h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        title={maximized ? '还原' : '最大化'}
        aria-label={maximized ? '还原' : '最大化'}
        className="flex h-8 w-10 items-center justify-center text-[var(--text-muted)] transition hover:bg-white/10 hover:text-[var(--text)]"
        onClick={() => void window.whisperApi?.maximizeToggle?.()}
      >
        {maximized ? (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path
              d="M3.5 4.5h5v5h-5zM4.5 3.5h4.5V8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <rect
              x="2.5"
              y="2.5"
              width="7"
              height="7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
        )}
      </button>
      <button
        type="button"
        title="关闭"
        aria-label="关闭"
        className="flex h-8 w-10 items-center justify-center text-[var(--text-muted)] transition hover:bg-red-500/90 hover:text-white"
        onClick={() => void window.whisperApi?.close?.()}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          <path
            d="M3 3l6 6M9 3L3 9"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  )
}
