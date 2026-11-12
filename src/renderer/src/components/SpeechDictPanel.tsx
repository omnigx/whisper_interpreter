import { useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { parseDictInput } from '../utils/speechDict'

export function SpeechDictPanel(): React.JSX.Element {
  const dict = useAppStore((s) => s.speechDict)
  const addEntry = useAppStore((s) => s.addSpeechDictEntry)
  const removeEntry = useAppStore((s) => s.removeSpeechDictEntry)
  const [input, setInput] = useState('')
  const entries = Object.entries(dict ?? {})
  const sorted = [...entries].sort(([a], [b]) => a.localeCompare(b))
  const handleAdd = (): void => {
    const parsed = parseDictInput(input)
    if (parsed) {
      addEntry(parsed.from, parsed.to)
      setInput('')
    }
  }
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-2">
        <span className="text-xs font-medium uppercase tracking-wider text-[var(--source)]">语音字典</span>
        <span className="text-[10px] text-[var(--text-muted)]">{entries.length} 条</span>
      </div>
      <div className="panel-scroll min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {sorted.map(([from, to]) => (
          <div key={from} className="flex items-center justify-between gap-2 py-0.5 text-[11px]">
            <span>{from} → {to}</span>
            <button type="button" onClick={() => removeEntry(from)} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--danger)]">✕</button>
          </div>
        ))}
        <div className="mt-2 flex gap-1.5 border-t border-[var(--border)] pt-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
            placeholder="原词;纠正词"
            className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-[var(--text)]"
          />
          <button type="button" onClick={handleAdd} className="rounded bg-[var(--accent-soft)] px-2 py-1 text-[10px] text-[var(--accent)]">添加</button>
        </div>
      </div>
    </div>
  )
}
