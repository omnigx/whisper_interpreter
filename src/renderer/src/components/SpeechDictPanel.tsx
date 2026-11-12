import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { parseDictInput } from '../utils/speechDict'

export function SpeechDictPanel(): React.JSX.Element {
  const dict = useAppStore((s) => s.speechDict)
  const addEntry = useAppStore((s) => s.addSpeechDictEntry)
  const removeEntry = useAppStore((s) => s.removeSpeechDictEntry)
  const setDict = useAppStore((s) => s.setSpeechDict)
  const [input, setInput] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

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
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-[var(--source)]">语音字典</span>
          <span className="text-[10px] text-[var(--text-muted)]">{entries.length > 0 ? `${entries.length} 条` : ''}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <input
            ref={fileRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) handleFilePick(f)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]"
            title="从 JSON 文件加载术语纠错表"
          >
            加载
          </button>
        </div>
      </div>
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
        <div className="mt-2 flex items-center gap-1.5 border-t border-[var(--border)] pt-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
            placeholder="原词;纠正词（回车添加）"
            className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-[var(--text)] placeholder:text-[var(--text-muted)]/50"
          />
          <button type="button" onClick={handleAdd} disabled={!input.trim()} className="shrink-0 rounded bg-[var(--accent-soft)] px-2 py-1 text-[10px] font-medium text-[var(--accent)] disabled:opacity-40">添加</button>
        </div>
      </div>
    </div>
  )
}
