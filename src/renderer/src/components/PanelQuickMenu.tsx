import { useEffect, useRef, useState, type ReactNode } from 'react'

interface PanelQuickMenuProps {
  label: string
  title: string
  icon: ReactNode
  children: ReactNode
  accentClass?: string
}

/** Small header icon + hover/click floating menu (same pattern as header settings). */
export function PanelQuickMenu({
  label,
  title,
  icon,
  children,
  accentClass = 'hover:border-[var(--accent)] hover:text-[var(--accent)]'
}: PanelQuickMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div
      ref={rootRef}
      className="relative shrink-0"
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        title={title}
        aria-label={label}
        aria-expanded={open}
        className={`inline-flex h-6 w-6 items-center justify-center rounded border border-[var(--border)] text-[var(--text-muted)] transition ${accentClass} ${
          open ? 'border-[var(--accent)] text-[var(--accent)]' : ''
        }`}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
      >
        {icon}
      </button>
      {open ? (
        <div
          className="absolute right-0 z-40 mt-1 min-w-[200px] rounded border border-[var(--border)] bg-[var(--bg-panel)] p-1.5 shadow-xl"
          style={{ top: 'calc(100% - 2px)' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

export function QuickMenuItem({
  active,
  children,
  onClick
}: {
  active?: boolean
  children: ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center rounded px-2.5 py-1.5 text-left text-[11px] transition ${
        active
          ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
          : 'text-[var(--text)] hover:bg-white/5'
      }`}
    >
      {children}
    </button>
  )
}

export function MicIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" />
    </svg>
  )
}

export function BrainIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
    </svg>
  )
}
