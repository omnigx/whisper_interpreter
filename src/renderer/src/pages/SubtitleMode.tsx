import { useCallback, useRef, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { DisplayControls } from '../components/DisplayControls'
import { LanguageTag } from '../components/LanguageTag'
import { detectLanguage } from '../utils/detectLanguage'

export function SubtitleMode(): React.JSX.Element {
  const transcripts = useAppStore((s) => s.transcripts)
  const partialText = useAppStore((s) => s.partialText)
  const translations = useAppStore((s) => s.translations)
  const splitRatio = useAppStore((s) => s.settings.subtitleSplitRatio)
  const setSubtitleSplitRatio = useAppStore((s) => s.setSubtitleSplitRatio)
  const seedDemoContent = useAppStore((s) => s.seedDemoContent)

  const containerRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const [showChrome, setShowChrome] = useState(true)

  const latestSource = [...transcripts].reverse().find((t) => t.text)
  const latestTarget = [...translations].reverse().find((t) => t.text)
  const sourceLang =
    latestSource?.lang ??
    (latestSource?.text ? detectLanguage(latestSource.text) : undefined) ??
    (partialText ? detectLanguage(partialText) : undefined)
  const targetLang = latestTarget?.lang

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const ratio = (e.clientY - rect.top) / rect.height
      setSubtitleSplitRatio(ratio)
    },
    [setSubtitleSplitRatio]
  )

  const stopDrag = useCallback(() => {
    dragging.current = false
  }, [])

  return (
    <div
      className="flex h-full flex-col overflow-hidden rounded-xl border border-white/15 bg-[#0b1220]/78 shadow-2xl backdrop-blur-md"
      onMouseEnter={() => setShowChrome(true)}
      onMouseLeave={() => setShowChrome(false)}
    >
      {/* Drag bar for frameless window */}
      <div
        className={`drag-region flex shrink-0 items-center justify-between px-3 transition-opacity ${
          showChrome ? 'h-8 opacity-100' : 'h-5 opacity-40'
        }`}
      >
        <span className="text-[10px] uppercase tracking-widest text-white/50">
          Whisper · Subtitle
        </span>
        <div className="no-drag flex items-center gap-1">
          <button
            type="button"
            className="rounded px-2 py-0.5 text-[10px] text-white/60 hover:bg-white/10 hover:text-white"
            onClick={seedDemoContent}
          >
            演示
          </button>
          <button
            type="button"
            className="rounded px-2 py-0.5 text-[10px] text-white/60 hover:bg-white/10 hover:text-white"
            onClick={() => void window.whisperApi?.openFullWindow()}
          >
            全尺寸
          </button>
          <button
            type="button"
            className="rounded px-2 py-0.5 text-[10px] text-white/60 hover:bg-white/10 hover:text-red-300"
            onClick={() => void window.whisperApi?.closeSubtitleWindow()}
          >
            关闭
          </button>
        </div>
      </div>

      {showChrome && (
        <div className="no-drag shrink-0 border-b border-white/10 px-3 py-1.5">
          <DisplayControls compact />
        </div>
      )}

      <div
        ref={containerRef}
        className="relative flex min-h-0 flex-1 flex-col"
        onPointerMove={onPointerMove}
        onPointerUp={stopDrag}
        onPointerLeave={stopDrag}
      >
        {/* Source (top) */}
        <div
          className="panel-scroll no-drag px-4 py-2"
          style={{ height: `${splitRatio * 100}%` }}
        >
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-sky-300/80">
            源语言
          </div>
          <p className="leading-snug text-sky-50/95">
            {latestSource?.text || partialText ? (
              <>
                <LanguageTag lang={sourceLang} compact />
                {latestSource?.text}
                {partialText ? (
                  <span className="text-sky-200/55 italic">
                    {latestSource?.text ? ' ' : ''}
                    {partialText}
                  </span>
                ) : null}
              </>
            ) : (
              '— 等待转写 —'
            )}
          </p>
        </div>

        {/* Draggable splitter */}
        <div
          className="no-drag group relative z-10 flex h-3 shrink-0 cursor-row-resize items-center justify-center"
          onPointerDown={(e) => {
            dragging.current = true
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
        >
          <div className="h-px w-full bg-white/20 group-hover:bg-[var(--accent)]" />
          <div className="absolute h-1 w-12 rounded-full bg-white/35 group-hover:bg-[var(--accent)]" />
        </div>

        {/* Target (bottom) */}
        <div className="panel-scroll no-drag min-h-0 flex-1 px-4 py-2">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-emerald-300/80">
            译文
          </div>
          <p className="leading-snug text-emerald-50/95">
            {latestTarget?.text ? (
              <>
                <LanguageTag lang={targetLang} compact />
                {latestTarget.text}
              </>
            ) : (
              '— 等待翻译 —'
            )}
          </p>
        </div>
      </div>
    </div>
  )
}
