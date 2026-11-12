import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../stores/appStore'

/**
 * 语音字典面板——STT 术语后纠。
 * 对称于右侧"专业术语（异步）"面板，位于左侧源语言转写下方。
 *
 * 条目格式：{ 原词: 纠正词 }，最少 2 字符（防单字误替换）。
 * 快速添加：底部输入框，宽容解析 ; ； : ： = ＝ 分隔符。
 * 持久化：terms/stt_dict/default.json，启动时自动加载。
 */

import { parseDictInput, MIN_FROM_LEN } from '../utils/speechDict'

export function SpeechDictPanel(): React.JSX.Element {
  const dict = useAppStore((s) => s.speechDict)
  const addEntry = useAppStore((s) => s.addSpeechDictEntry)
  const removeEntry = useAppStore((s) => s.removeSpeechDictEntry)
  const setDict = useAppStore((s) => s.setSpeechDict)

  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 启动时从文件加载
  useEffect(() => {
    void window.whisperApi
      ?.readSpeechDict?.()
      .then((entries) => {
        if (entries && Object.keys(entries).length > 0) {
          setDict(entries)
        }
      })
      .catch(() => undefined)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 字典变更时防抖保存
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void window.whisperApi?.writeSpeechDict?.(dict).catch(() => undefined)
    }, 1000)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [dict])

  const entries = Object.entries(dict)
  const sorted = [...entries].sort(([a], [b]) => a.localeCompare(b))

  // 自动滚动到底部（新条目可见）
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [entries.length])

  const handleAdd = useCallback((): void => {
    const parsed = parseDictInput(input)
    if (!parsed) {
      setError(
        input.trim().length === 0
          ? null
          : `格式无效或原词不足 ${MIN_FROM_LEN} 字`
      )
      return
    }
    addEntry(parsed.from, parsed.to)
    setInput('')
    setError(null)
  }, [input, addEntry])

  const handleClearAll = useCallback((): void => {
    setDict({})
  }, [setDict])

  return (
    <div className="flex min-h-0 flex-col">
      {/* 头部 */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-[var(--source)]">
            语音字典
          </span>
          <span className="text-[10px] text-[var(--text-muted)]">
            {entries.length > 0 ? `${entries.length} 条` : ''}
          </span>
          {error ? (
            <span className="truncate text-[10px] text-[var(--danger)]" title={error}>
              {error}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={handleClearAll}
            disabled={entries.length === 0}
            className="rounded border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--text-muted)] transition hover:border-[var(--danger)] hover:text-[var(--danger)] disabled:cursor-not-allowed disabled:opacity-40"
            title="清空所有条目"
          >
            清空
          </button>
        </div>
      </div>

      {/* 条目列表 */}
      <div
        ref={listRef}
        className="panel-scroll min-h-0 flex-1 overflow-y-auto px-4 py-2"
      >
        {sorted.length === 0 ? (
          <p className="py-2 text-[11px] text-[var(--text-muted)]/70">
            在下方输入 <span className="font-mono">原词;纠正词</span> 添加条目，
            如 <span className="font-mono">吸出;析出</span>。
            条目实时生效于 STT 输出。
          </p>
        ) : (
          sorted.map(([from, to]) => (
            <div
              key={from}
              className="group flex items-center justify-between gap-2 py-0.5 text-[11px]"
            >
              <span className="min-w-0 flex items-center gap-1.5">
                <span className="truncate text-[var(--text)]">{from}</span>
                <span className="shrink-0 text-[var(--text-muted)]/50">→</span>
                <span className="truncate text-[var(--accent)]">{to}</span>
              </span>
              <button
                type="button"
                onClick={() => removeEntry(from)}
                className="shrink-0 rounded px-1 text-[10px] text-[var(--text-muted)] opacity-0 transition group-hover:opacity-100 hover:text-[var(--danger)]"
                title="删除此条目"
              >
                ✕
              </button>
            </div>
          ))
        )}

        {/* 快速添加输入框（固定在列表底部） */}
        <div className="mt-2 flex items-center gap-1.5 border-t border-[var(--border)] pt-2">
          <input
            type="text"
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd()
            }}
            placeholder="原词;纠正词（回车添加）"
            className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-[var(--text)] placeholder:text-[var(--text-muted)]/50 focus:border-[var(--accent)] focus:outline-none"
          />
          <button
            type="button"
            onClick={handleAdd}
            disabled={!input.trim()}
            className="shrink-0 rounded bg-[var(--accent-soft)] px-2 py-1 text-[10px] font-medium text-[var(--accent)] transition hover:bg-[var(--accent)]/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            添加
          </button>
        </div>
      </div>
    </div>
  )
}
