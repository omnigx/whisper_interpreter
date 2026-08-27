import type { DetectedLanguage } from '../utils/detectLanguage'

interface LanguageTagProps {
  lang?: DetectedLanguage | null
  /** Compact [中]/[英] vs [ZH]/[EN] */
  compact?: boolean
  className?: string
}

const STYLES: Record<
  Exclude<DetectedLanguage, 'unknown'>,
  { label: string; compact: string; className: string }
> = {
  zh: {
    label: 'ZH',
    compact: '中',
    className:
      'border-sky-400/40 bg-sky-500/15 text-sky-300'
  },
  en: {
    label: 'EN',
    compact: '英',
    className:
      'border-orange-400/40 bg-orange-500/15 text-orange-300'
  }
}

/** Small source-language badge for STT / translation rows */
export function LanguageTag({
  lang,
  compact = false,
  className = ''
}: LanguageTagProps): React.JSX.Element | null {
  if (!lang || lang === 'unknown') return null
  const style = STYLES[lang]
  return (
    <span
      className={`mr-1.5 inline-flex shrink-0 translate-y-[-1px] items-center rounded border px-1 py-px font-mono text-[10px] font-semibold tracking-wide ${style.className} ${className}`}
      style={{ lineHeight: 1 }}
      title={lang === 'zh' ? '检测到中文' : '检测到英文'}
    >
      {compact ? style.compact : style.label}
    </span>
  )
}
