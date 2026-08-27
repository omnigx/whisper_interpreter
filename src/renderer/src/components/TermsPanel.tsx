import { useMemo, useState, type CSSProperties, type RefObject } from 'react'
import type { TermItem } from '@shared/types'
import { useAppStore } from '../stores/appStore'
import { copyTextToClipboard } from '../utils/clipboard'
import { sortTerms } from '../utils/termHelpers'

interface TermsPanelProps {
  contentPanelStyle: CSSProperties
  foreignTextStyle: CSSProperties
  chineseTextStyle: CSSProperties
  scrollRef?: RefObject<HTMLDivElement | null>
}

export function TermsPanel({
  contentPanelStyle,
  foreignTextStyle,
  chineseTextStyle,
  scrollRef
}: TermsPanelProps): React.JSX.Element {
  const terms = useAppStore((s) => s.terms)
  const isLlmExtractionEnabled = useAppStore((s) => s.isLlmExtractionEnabled)
  const toggleTermPin = useAppStore((s) => s.toggleTermPin)
  const removeTerm = useAppStore((s) => s.removeTerm)
  const [toast, setToast] = useState<string | null>(null)

  const sorted = useMemo(() => sortTerms(terms), [terms])

  const showToast = (msg: string): void => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 1400)
  }

  const handleCopy = async (item: TermItem): Promise<void> => {
    try {
      await copyTextToClipboard(item.foreignText)
      showToast('已复制')
    } catch {
      showToast('复制失败')
    }
  }

  const emptyHint = isLlmExtractionEnabled
    ? 'AI 智能提取已开启 · 讲者停顿后异步抽取术语（不阻塞翻译）'
    : 'AI 智能提取已关闭 · CSV 词表匹配仍常驻；点标题旁闪电图标开启'

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className="custom-scrollbar panel-scroll min-h-0 flex-1 overflow-y-auto px-2 py-1"
        style={contentPanelStyle}
        title="Ctrl + 滚轮调节字号"
      >
        {sorted.length === 0 ? (
          <p className="px-1 text-sm text-[var(--text-muted)]/70">{emptyHint}</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {sorted.map((item) => (
              <TermBubble
                key={item.id}
                item={item}
                foreignTextStyle={foreignTextStyle}
                chineseTextStyle={chineseTextStyle}
                onPin={() => toggleTermPin(item.id)}
                onCopy={() => void handleCopy(item)}
                onClose={() => removeTerm(item.id)}
              />
            ))}
          </div>
        )}
      </div>

      {toast ? (
        <div className="pointer-events-none absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded bg-black/70 px-2.5 py-1 text-[11px] text-white shadow">
          {toast}
        </div>
      ) : null}
    </div>
  )
}

function TermBubble({
  item,
  foreignTextStyle,
  chineseTextStyle,
  onPin,
  onCopy,
  onClose
}: {
  item: TermItem
  foreignTextStyle: CSSProperties
  chineseTextStyle: CSSProperties
  onPin: () => void
  onCopy: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="group flex items-center justify-between gap-1 rounded-md bg-white/10 px-2 py-1 transition-colors hover:bg-white/15">
      <div className="min-w-0 flex-1 text-left leading-tight">
        <div
          className="truncate leading-tight text-[var(--text)]"
          style={{ ...foreignTextStyle, lineHeight: 1.2 }}
          title={item.foreignText}
        >
          {item.foreignText}
        </div>
        <div
          className="truncate text-[0.9em] leading-tight text-[var(--term)]"
          style={{ ...chineseTextStyle, lineHeight: 1.2 }}
          title={item.chineseText}
        >
          {item.chineseText}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0 opacity-40 transition-opacity group-hover:opacity-100">
        <IconButton
          label={item.isPinned ? '取消置顶' : '置顶'}
          onClick={onPin}
          active={item.isPinned}
        >
          <PinIcon filled={item.isPinned} />
        </IconButton>
        <IconButton label="复制外文" onClick={onCopy}>
          <CopyIcon />
        </IconButton>
        <IconButton label="关闭" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>
    </div>
  )
}

function IconButton({
  label,
  onClick,
  active,
  children
}: {
  label: string
  onClick: () => void
  active?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={`inline-flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-white/10 ${
        active ? 'text-[var(--term)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'
      }`}
    >
      {children}
    </button>
  )
}

function PinIcon({ filled }: { filled: boolean }): React.JSX.Element {
  if (filled) {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M16 3a1 1 0 0 1 .8 1.6L14.4 9H17a1 1 0 0 1 .8 1.6l-8 10A1 1 0 0 1 8 20v-6H5a1 1 0 0 1-.8-1.6l8-10A1 1 0 0 1 13 2h3a1 1 0 0 1 1 1Z" />
      </svg>
    )
  }
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
      <path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1z" />
    </svg>
  )
}

function CopyIcon(): React.JSX.Element {
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
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function CloseIcon(): React.JSX.Element {
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
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}
