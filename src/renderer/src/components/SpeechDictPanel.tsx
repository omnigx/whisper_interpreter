import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { parseDictInput, normalizeDictJson, type SpeechDictMode } from '../utils/speechDict'
import { useClickOutside } from '../hooks/useClickOutside'

const MODE_LABELS: Record<SpeechDictMode, string> = {
  off: 'N/A (不启用)',
  exact: '全字匹配',
  fuzzy: '模糊匹配'
}
const MODE_SHORT: Record<SpeechDictMode, string> = {
  off: '关',
  exact: '全字',
  fuzzy: '拼音'
}

export function SpeechDictPanel({
  collapsed,
  onToggle
}: {
  collapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
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
        const clean = normalizeDictJson(result)
        if (Object.keys(clean).length > 0) setDict(clean)
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

  /** 安全导入：支持 object（原词→纠正 或 术语→术语）与 array（仅术语）两种格式，
   *  混合格式自然兼容；无效/超限 JSON 静默跳过，不崩溃（详见 normalizeDictJson）。 */
  const handleFilePick = (file: File): void => {
    if (file.size > 1_048_576) return // 1MB 上限
    const reader = new FileReader()
    reader.onerror = () => undefined
    reader.onload = () => {
      try {
        const clean = normalizeDictJson(JSON.parse(String(reader.result)))
        if (Object.keys(clean).length > 0) setDict(clean)
      } catch { /* invalid JSON */ }
    }
    reader.readAsText(file)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 头部：标题 + 收起/展开 + 匹配模式 + 加载（图标按钮） */}
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-2">
        <span className="text-xs font-medium uppercase tracking-wider text-[var(--source)]">
          语音字典{collapsed && entries.length > 0 ? ` · ${entries.length} 条` : ''}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* 收起/展开（抽屉）图标按钮 */}
          <button
            type="button"
            aria-label={collapsed ? '展开语音字典' : '收起语音字典'}
            title={collapsed ? '展开语音字典' : '收起语音字典'}
            onClick={onToggle}
            className="flex h-6 w-6 items-center justify-center rounded border border-[var(--border)] text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)]"
          >
            <ChevronIcon up={collapsed} />
          </button>
          {/* 匹配模式图标按钮 */}
          <div ref={modeRef} className="settings-wrapper relative">
            <button
              type="button"
              aria-label="匹配模式"
              title={`语音字典：${MODE_LABELS[dictMode]}`}
              onClick={() => setModeOpen(v => !v)}
              className={`flex h-6 w-6 items-center justify-center rounded border transition ${
                dictMode === 'off'
                  ? 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)]'
                  : 'border-[var(--accent)] text-[var(--accent)]'
              }`}
            >
              <ModeIcon active={dictMode !== 'off'} />
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
          {/* 加载图标按钮 */}
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
            aria-label="加载字典"
            title="从 JSON 文件加载术语表（模糊模式下加载正确术语即可）"
            onClick={() => fileRef.current?.click()}
            className="flex h-6 w-6 items-center justify-center rounded border border-[var(--border)] text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)]"
          >
            <LoadIcon />
          </button>
        </div>
      </div>

      {/* 内容区：0fr↔1fr 抽屉收合动画（组件保持挂载，输入框文字不丢失） */}
      <div
        className="grid min-h-0 flex-1 transition-[grid-template-rows] duration-200 ease-in-out"
        style={{ gridTemplateRows: collapsed ? '0fr' : '1fr' }}
      >
        <div
          className={`flex min-h-0 flex-col overflow-hidden transition-opacity duration-150 ${
            collapsed ? 'opacity-0' : 'opacity-100'
          }`}
        >
      {/* 词条列表（可滚动） */}
      <div className="panel-scroll min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {sorted.length === 0 ? (
          <p className="py-2 text-[11px] text-[var(--text-muted)]/70">
            输入 原词;纠正词 添加条目，或点击加载导入术语表
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

      {/* 快速添加输入框（固定底部） */}
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
      </div>
    </div>
  )
}

/** 抽屉收合箭头：展开时朝下（点击收起），收起时朝上（点击展开） */
function ChevronIcon({ up }: { up: boolean }): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {up ? <path d="m18 15-6-6-6 6" /> : <path d="m6 9 6 6 6-6" />}
    </svg>
  )
}

/** 字典/拼写检查图标（书本 + 勾） */
function ModeIcon({ active }: { active: boolean }): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      {active && <path d="m9 10 2 2 4-4" />}
    </svg>
  )
}

/** 加载/导入图标（文件夹打开） */
function LoadIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <path d="M10 13l2 2 4-4" />
    </svg>
  )
}

