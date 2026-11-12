import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { parseDictInput, type SpeechDictMode } from '../utils/speechDict'
import { useClickOutside } from '../hooks/useClickOutside'

const MODE_LABELS: Record<SpeechDictMode, string> = {
  off: '不启用',
  exact: '全字匹配',
  fuzzy: '模糊匹配'
}

export function SpeechDictPanel(): React.JSX.Element {
  const dict = useAppStore((s) => s.speechDict)
  const dictMode = useAppStore((s) => s.speechDictMode)
  const addEntry = useAppStore((s) => s.addSpeechDictEntry)
  const removeEntry = useAppStore((s) => s.removeSpeechDictEntry)
  const setDict = useAppStore((s) => s.setSpeechDict)
  const setMode = useAppStore((s) => s.setSpeechDictMode)
  const [input, setInput] = useState('')
  const [modeOpen, setModeOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const modeRef = useRef<HTMLDivElement>(null)

  useClickOutside(modeRef, modeOpen, () => setModeOpen(false))

  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const result = await window.whisperApi?.readSpeechDict?.()
        if (result && typeof result === 'object' && !Array.isArray(result)) {
          const clean = Object.fromEntries(
            Object.entries(result).filter(([, v]) => typeof v === 'string')
          )
          if (Object.keys(clean).length > 0) setDict(clean)
        }
      } catch { /* ignore */ }
    }
    void load()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const entries = Object.entries(dict ?? {})
  const sorted = [...entries].sort(([a], [b]) => a.localeCompare(b))

  const handleAdd = (): void => {
    const parsed = parseDictInput(input)
    if (parsed) { addEntry(parsed.from, parsed.to); setInput('') }
  }

  const handleFilePick = (file: File): void => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const json = JSON.parse(String(reader.result))
        if (json && typeof json === 'object' && !Array.isArray(json)) {
          setDict(json as Record<string, string>)
        }
      } catch { /* invalid JSON */ }
    }
    reader.readAsText(file)
  }

  return (
    <div className="flex min-h-0 flex-col">
      {/* 头部：标题 + 匹配模式 + 加载 */}
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-2">
        <span className="text-xs font-medium uppercase tracking-wider text-[var(--source)]">语音字典</span>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* 匹配模式下拉 */}
          <div ref={modeRef} className="settings-wrapper relative">
            <button
              type="button"
              onClick={() => setModeOpen(v => !v)}
              className={`inline-flex h-6 items-center gap-1 rounded border px-1.5 text-[10px] transition ${
                dictMode === 'off'
                  ? 'border-[var(--border)] text-[var(--text-muted)]'
                  : 'border-[var(--accent)] text-[var(--accent)]'
              } hover:border-[var(--accent)]`}
              title="语音字典匹配模式"
            >
              {MODE_LABELS[dictMode]}
            </button>
            {modeOpen && (
              <div
                className="settings-panel absolute right-0 z-50 mt-1 min-w-[100px] rounded border border-[var(--border)] bg-[var(--bg-panel)] p-1 shadow-xl"
                onMouseDown={e => e.stopPropagation()}
              >
                {(['off', 'exact', 'fuzzy'] as SpeechDictMode[]).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => { setMode(m); setModeOpen(false) }}
                    className={`flex w-full items-center rounded px-2 py-1 text-left text-[10px] transition ${
                      dictMode === m
                        ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'text-[var(--text)] hover:bg-white/5'
                    }`}
                  >
                    {MODE_LABELS[m]}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* 加载按钮 */}
          <input
            ref={fileRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) handleFilePick(f)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="inline-flex h-6 items-center rounded border border-[var(--border)] px-1.5 text-[10px] text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)]"
            title="从 JSON 文件加载术语纠错表"
          >
            加载
          </button>
        </div>
      </div>

      {/* 词条列表（可滚动） */}
      <div className="panel-scroll min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {sorted.length === 0 ? (
          <p className="py-2 text-[11px] text-[var(--text-muted)]/70">
            输入 原词;纠正词 添加条目，或点击「加载」导入 JSON 文件
          </p>
        ) : (
          sorted.map(([from, to]) => (
            <div key={from} className="group flex items-center justify-between gap-2 py-0.5 text-[11px]">
              <span className="min-w-0 flex items-center gap-1.5">
                <span className="truncate text-[var(--text)]">{from}</span>
                <span className="shrink-0 text-[var(--text-muted)]/50">→</span>
                <span className="truncate text-[var(--accent)]">{to}</span>
              </span>
              <button type="button" onClick={() => removeEntry(from)} className="shrink-0 rounded px-1 text-[10px] text-[var(--text-muted)] opacity-0 group-hover:opacity-100 hover:text-[var(--danger)]">✕</button>
            </div>
          ))
        )}
      </div>

      {/* 快速添加输入框（固定底部，不随列表滚动） */}
      <div className="shrink-0 border-t border-[var(--border)] px-4 py-2">
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
            placeholder="原词;纠正词（回车添加）"
            className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-[var(--text)] placeholder:text-[var(--text-muted)]/50 focus:border-[var(--accent)] focus:outline-none"
          />
          <button type="button" onClick={handleAdd} disabled={!input.trim()} className="shrink-0 rounded bg-[var(--accent-soft)] px-2 py-1 text-[10px] font-medium text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40">添加</button>
        </div>
      </div>
    </div>
  )
}
