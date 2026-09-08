import { useCallback, useEffect, useRef, useState } from 'react'
import {
  useAudioTranscriber,
  type LocalSttEngine,
  type WsConnectionStatus
} from '../hooks/useAudioTranscriber'
import { createLlmClient } from '../services/llm'
import { defaultSttWebsocketUrl, getActiveLlm } from '@shared/types'
import { useAppStore } from '../stores/appStore'
import {
  buildTranslateUserContent,
  isEchoRepetition,
  resolveTranslationRoute,
  directionLabel
} from '../services/translationDirection'
import { detectLanguage } from '../utils/detectLanguage'
import { createThrottledEmitter } from '../utils/streamingUpdate'
import { subscribeMeter } from '../services/meterBus'
import { LanguageTag } from '../components/LanguageTag'
import { logSessionEvent } from '../services/sessionLogger'
import { AppFooter } from '../components/AppFooter'
import { EngineSettingsPanel } from '../components/EngineSettingsPanel'
import { WindowControls } from '../components/WindowControls'

const STATUS_COLOR: Record<WsConnectionStatus, string> = {
  connecting: '#fbbf24',
  connected: '#34d399',
  disconnected: '#64748b',
  error: '#f87171'
}

const STATUS_LABEL: Record<WsConnectionStatus, string> = {
  connecting: '连接中',
  connected: '已连接',
  disconnected: '未连接',
  error: '错误'
}

const LOG_PREVIEW_FONT =
  '"Noto Serif CJK SC", "Noto Serif SC", "Source Serif 4", "Source Han Serif SC", SimSun, "Microsoft YaHei", serif'

interface DictationTestProps {
  onBack?: () => void
}

interface LogFileInfo {
  name: string
  size: number
  mtimeMs: number
}

interface RecordingFileInfo {
  name: string
  size: number
  mtimeMs: number
  birthtimeMs: number
  ext: string
  durationSec?: number
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return '—'
  }
}

function formatDuration(sec?: number): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—'
  const s = Math.round(sec)
  const m = Math.floor(s / 60)
  const r = s % 60
  return m > 0 ? `${m}m ${r}s` : `${r}s`
}

/**
 * 测试模式：三栏文件管理器布局
 * 1) 本地STT测试  2) 录音管理  3) 日志管理
 */
export function DictationTest({ onBack }: DictationTestProps): React.JSX.Element {
  const storeProvider = useAppStore((s) => s.settings.stt.provider)
  const display = useAppStore((s) => s.settings.display)
  const initialEngine: LocalSttEngine =
    storeProvider === 'local-paraformer' ? 'paraformer' : 'sensevoice'

  const [engine, setEngine] = useState<LocalSttEngine>(initialEngine)
  const [wsUrlInput, setWsUrlInput] = useState(
    defaultSttWebsocketUrl(
      engine === 'paraformer' ? 'local-paraformer' : 'local-sensevoice'
    )
  )
  const [appliedWsUrl, setAppliedWsUrl] = useState(wsUrlInput)
  const upsertTranscript = useAppStore((s) => s.upsertTranscript)
  const upsertTranslation = useAppStore((s) => s.upsertTranslation)
  const removeTranslation = useAppStore((s) => s.removeTranslation)
  const setPipelineStatus = useAppStore((s) => s.setPipelineStatus)
  const historyRef = useRef<string[]>([])
  const translateChainRef = useRef<Promise<void>>(Promise.resolve())

  const [logFiles, setLogFiles] = useState<LogFileInfo[]>([])
  const [selectedLog, setSelectedLog] = useState<string | null>(null)
  const [logPreview, setLogPreview] = useState('')

  const [recordings, setRecordings] = useState<RecordingFileInfo[]>([])
  const [selectedRec, setSelectedRec] = useState<string | null>(null)
  const [engineOpen, setEngineOpen] = useState(false)

  const maxDuration = engine === 'sensevoice' ? 15 : 10
  // Shared with the main pipeline — one sentence-break pause everywhere
  const silenceMs = useAppStore((s) => s.settings.audio.vadSilenceMs)
  const contentFontSize = Math.round(display.fontSize * (display.zoomScale || 1))

  const selectedRecording = recordings.find((r) => r.name === selectedRec) ?? null

  const refreshLogs = useCallback(async (): Promise<void> => {
    try {
      const list = (await window.whisperApi?.listSessionLogs?.()) ?? []
      setLogFiles(list)
      setSelectedLog((prev) => {
        if (prev && list.some((f) => f.name === prev)) return prev
        return list[0]?.name ?? null
      })
    } catch {
      setLogFiles([])
    }
  }, [])

  const refreshRecordings = useCallback(async (): Promise<void> => {
    try {
      const list = (await window.whisperApi?.listRecordings?.()) ?? []
      setRecordings(list)
      setSelectedRec((prev) => {
        if (prev && list.some((f) => f.name === prev)) return prev
        return list[0]?.name ?? null
      })
    } catch {
      setRecordings([])
    }
  }, [])

  useEffect(() => {
    void refreshLogs()
    void refreshRecordings()
  }, [refreshLogs, refreshRecordings])

  useEffect(() => {
    if (!selectedLog) {
      setLogPreview('')
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const res = await window.whisperApi?.readSessionLog?.(selectedLog)
        if (cancelled) return
        if (res?.ok && typeof res.content === 'string') setLogPreview(res.content)
        else setLogPreview(res?.error ? `读取失败：${res.error}` : '')
      } catch (e) {
        if (!cancelled) {
          setLogPreview(e instanceof Error ? e.message : String(e))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedLog])

  const translateFinal = (text: string, sourceId?: string): void => {
    const settings = useAppStore.getState().settings
    const cfg = getActiveLlm(settings)
    if (!cfg) {
      setPipelineStatus('无可用 LLM，请在引擎设置中配置')
      return
    }
    const llm = createLlmClient(cfg)
    const mainMode = settings.translationDirection ?? 'en-zh'
    const { detected, actualDirection, reversed, systemPrompt } =
      resolveTranslationRoute(text, mainMode)
    const history = historyRef.current.slice(-8)
    const userContent = buildTranslateUserContent(text, history, actualDirection)

    translateChainRef.current = translateChainRef.current.then(async () => {
      const id = `tr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      const linkedSourceId = sourceId ?? id
      const started = performance.now()
      upsertTranslation({
        id,
        sourceId: linkedSourceId,
        text: '',
        streaming: true,
        timestamp: Date.now(),
        lang: detected,
        direction: actualDirection
      })
      const routeHint = reversed
        ? `Auto-LID 反向 · ${directionLabel(actualDirection)}`
        : directionLabel(actualDirection)
      setPipelineStatus(`翻译中 · ${routeHint} · LID=${detected} → ${llm.label}`)
      const throttledUi = createThrottledEmitter(80)
      let assembled = ''
      let firstTokenAt: number | null = null
      try {
        assembled = await llm.translateStream(
          userContent,
          (chunk) => {
            if (firstTokenAt === null) firstTokenAt = performance.now()
            assembled += chunk
            throttledUi.emit(() => {
              if (isEchoRepetition(text, assembled)) return
              upsertTranslation({
                id,
                sourceId: linkedSourceId,
                text: assembled,
                streaming: true,
                timestamp: Date.now(),
                lang: detected,
                direction: actualDirection
              })
            })
          },
          undefined,
          { systemPrompt }
        )
        if (isEchoRepetition(text, assembled)) {
          removeTranslation(id)
          setPipelineStatus('已拦截复读原文的无效译文')
          logSessionEvent({
            module: 'LLM',
            model_name: cfg.model || llm.label || cfg.id,
            content: assembled,
            latency: Math.round(performance.now() - started),
            direction: actualDirection,
            source_text: text,
            failed: true,
            echo_intercepted: true
          })
          return
        }
        upsertTranslation({
          id,
          sourceId: linkedSourceId,
          text: assembled,
          streaming: false,
          timestamp: Date.now(),
          lang: detected,
          direction: actualDirection
        })
        logSessionEvent({
          module: 'LLM',
          model_name: cfg.model || llm.label || cfg.id,
          content: assembled,
          latency: Math.round(performance.now() - started),
          ...(firstTokenAt !== null
            ? { first_token_ms: Math.round(firstTokenAt - started) }
            : {}),
          direction: actualDirection,
          source_text: text
        })
        historyRef.current = [...historyRef.current, text].slice(-20)
        setPipelineStatus(
          `翻译完成 · ${reversed ? '反向 ' : ''}${directionLabel(actualDirection)} · ${llm.label}`
        )
        void refreshLogs()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        upsertTranslation({
          id,
          sourceId: linkedSourceId,
          text: assembled || `[翻译失败] ${msg}`,
          streaming: false,
          timestamp: Date.now(),
          lang: detected,
          direction: actualDirection
        })
        setPipelineStatus(`翻译失败：${msg}`)
        logSessionEvent({
          module: 'LLM',
          model_name: cfg.model || llm.label || cfg.id,
          content: assembled || `[翻译失败] ${msg}`,
          latency: Math.round(performance.now() - started),
          direction: actualDirection,
          source_text: text,
          failed: true
        })
      }
    })
  }

  const {
    startRecording,
    stopRecording,
    finalTranscripts,
    partialText,
    isRecording,
    connectionStatus,
    clearTranscripts,
    error
  } = useAudioTranscriber({
    engine,
    wsUrl: appliedWsUrl,
    maxDuration,
    silenceMs,
    punctuationSettle: true,
    onFinal: (text) => {
      const id = `sv-${Date.now()}`
      const lang = detectLanguage(text)
      upsertTranscript({
        id,
        text,
        isFinal: true,
        timestamp: Date.now(),
        lang
      })
      logSessionEvent({
        module: 'STT',
        model_name: engine === 'paraformer' ? 'Paraformer' : 'SenseVoice',
        content: text
      })
      void refreshLogs()
      translateFinal(text, id)
    }
  })

  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [finalTranscripts, partialText])

  const switchEngine = (next: LocalSttEngine): void => {
    if (isRecording) stopRecording()
    setEngine(next)
    const url = defaultSttWebsocketUrl(
      next === 'paraformer' ? 'local-paraformer' : 'local-sensevoice'
    )
    setWsUrlInput(url)
    setAppliedWsUrl(url)
    clearTranscripts()
    historyRef.current = []
  }

  const applyUrl = (): void => {
    if (isRecording) stopRecording()
    setAppliedWsUrl(wsUrlInput.trim() || appliedWsUrl)
  }

  const toggle = (): void => {
    if (isRecording) {
      stopRecording()
      void refreshRecordings()
    } else {
      historyRef.current = []
      void startRecording().catch(() => undefined)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--bg-deep)] text-[var(--text)]">
      {/*
        顶栏与主界面同构：右侧控件顺序/尺寸一致，
        「返回」落在主界面「测试」同一物理位置（字幕之后、演示之前）。
      */}
      <header className="drag-region flex h-12 shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-panel)] pl-4 pr-1">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-wide text-[var(--text)]">
              测试模式
            </h1>
            <p className="truncate text-[10px] text-[var(--text-muted)]">
              {engine === 'sensevoice'
                ? `SenseVoice · 静音 ${silenceMs}ms / max ${maxDuration}s`
                : `Paraformer · 静音 ${silenceMs}ms / max ${maxDuration}s`}
            </p>
          </div>
        </div>

        <div
          className="no-drag flex h-8 shrink-0 items-center gap-1.5"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {/* 占位：英译中 / 中译英 */}
          <div
            className="pointer-events-none invisible inline-flex h-8 items-center rounded border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5"
            aria-hidden
          >
            <span className="inline-flex h-7 items-center whitespace-nowrap rounded px-2.5 text-xs font-medium">
              英译中
            </span>
            <span className="inline-flex h-7 items-center whitespace-nowrap rounded px-2.5 text-xs font-medium">
              中译英
            </span>
          </div>

          {/* 占位：开始听写 */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="pointer-events-none invisible inline-flex h-8 items-center whitespace-nowrap rounded px-2.5 text-xs font-medium"
          >
            开始听写
          </button>

          {/* 占位：字幕 */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="pointer-events-none invisible inline-flex h-8 items-center whitespace-nowrap rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 text-xs"
          >
            字幕
          </button>

          {/* 真实按钮：对齐主界面「测试」 */}
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex h-8 items-center whitespace-nowrap rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 text-xs text-[var(--text)] hover:border-[var(--accent)]"
            >
              返回
            </button>
          ) : (
            <span className="inline-flex h-8 w-[3.25rem]" aria-hidden />
          )}

          {/* 占位：演示 / 清空 */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="pointer-events-none invisible inline-flex h-8 items-center whitespace-nowrap rounded border border-[var(--border)] px-2.5 text-xs"
          >
            演示
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="pointer-events-none invisible inline-flex h-8 items-center whitespace-nowrap rounded border border-[var(--border)] px-2.5 text-xs"
          >
            清空
          </button>

          {/* 占位：录音 / 引擎 / 字体设置图标按钮 h-8 w-8 */}
          <span
            className="pointer-events-none invisible inline-flex h-8 w-8 rounded border"
            aria-hidden
          />
          <span
            className="pointer-events-none invisible inline-flex h-8 w-8 rounded border"
            aria-hidden
          />
          <span
            className="pointer-events-none invisible inline-flex h-8 w-8 rounded border"
            aria-hidden
          />

          <WindowControls />
        </div>
      </header>

      {/* 三栏纵向布局 1:2:2 */}
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,2fr)] gap-2 p-2">
        {/* ========== 1. 本地STT测试 ========== */}
        <section className="flex min-h-0 flex-col overflow-hidden rounded border border-[var(--border)] bg-[var(--bg-panel)]">
          <div className="flex shrink-0 items-center border-b border-[var(--border)] px-3 py-1.5">
            <span className="text-xs font-medium uppercase tracking-wider text-[var(--source)]">
              本地STT测试
            </span>
          </div>

          <div className="flex shrink-0 flex-wrap items-end gap-2 border-b border-[var(--border)] px-3 py-2">
            <label className="flex flex-col gap-0.5 text-[10px] tracking-wider text-[var(--text-muted)]">
              引擎
              <select
                className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-[var(--text)]"
                value={engine}
                onChange={(e) => switchEngine(e.target.value as LocalSttEngine)}
              >
                <option value="sensevoice">SenseVoice（稳定/抗噪）</option>
                <option value="paraformer">Paraformer（极速流式）</option>
              </select>
            </label>

            <label className="flex min-w-[200px] flex-1 flex-col gap-0.5 text-[10px] tracking-wider text-[var(--text-muted)]">
              WebSocket
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={wsUrlInput}
                  onChange={(e) => setWsUrlInput(e.target.value)}
                  className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 font-mono text-[11px] text-[var(--text)]"
                />
                <button
                  type="button"
                  onClick={applyUrl}
                  className="shrink-0 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]"
                >
                  应用
                </button>
              </div>
            </label>

            <button
              type="button"
              onClick={toggle}
              className={`inline-flex h-7 items-center rounded px-2.5 text-xs font-medium ${
                isRecording
                  ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
                  : 'bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--accent)]/25'
              }`}
            >
              {isRecording ? '停止听写' : '开始听写'}
            </button>

            <button
              type="button"
              onClick={() => {
                clearTranscripts()
                historyRef.current = []
              }}
              className="inline-flex h-7 items-center rounded border border-[var(--border)] px-2 text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              清空转写
            </button>

            <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: STATUS_COLOR[connectionStatus] }}
              />
              {STATUS_LABEL[connectionStatus]}
            </span>

            <TestLevelMeter active={isRecording} />
          </div>

          {error ? (
            <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300">
              {error}
            </div>
          ) : null}

          <div
            ref={listRef}
            className="panel-scroll min-h-0 flex-1 space-y-1 overflow-y-auto bg-[var(--bg-deep)] px-3 py-1.5"
            style={{ fontSize: `${contentFontSize}px` }}
          >
            {finalTranscripts.length === 0 && !partialText ? (
              <p className="text-[var(--text-muted)]/70">
                SenseVoice：整句上屏并翻译。Paraformer：灰字 partial + 黑字 final。
              </p>
            ) : (
              <>
                {finalTranscripts.map((line, i) => (
                  <div key={`${i}-${line.slice(0, 12)}`} className="text-[var(--text)]">
                    <LanguageTag lang={detectLanguage(line)} />
                    <span className="whitespace-pre-wrap break-words">{line}</span>
                  </div>
                ))}
                {partialText ? (
                  <div className="rounded bg-sky-500/15 px-2 py-1 text-[var(--text-muted)] italic">
                    <LanguageTag lang={detectLanguage(partialText)} />
                    <span className="whitespace-pre-wrap break-words">{partialText}</span>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </section>

        {/* ========== 2. 录音管理 ========== */}
        <section className="flex min-h-0 flex-col overflow-hidden rounded border border-[var(--border)] bg-[var(--bg-panel)]">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-1.5">
            <span className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
              录音管理
            </span>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => void refreshRecordings()}
                className="inline-flex h-6 items-center rounded border border-[var(--border)] px-2 text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                刷新列表
              </button>
              <button
                type="button"
                onClick={() => void window.whisperApi?.openRecordingsDir?.()}
                className="inline-flex h-6 items-center rounded border border-[var(--border)] px-2 text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                打开目录
              </button>
            </div>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-2 gap-0">
            <div className="flex min-h-0 flex-col border-r border-[var(--border)]">
              <div className="shrink-0 border-b border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-muted)]">
                录音列表
              </div>
              <div className="panel-scroll min-h-0 flex-1 overflow-y-auto bg-[var(--bg-elevated)]">
                {recordings.length === 0 ? (
                  <p className="px-2 py-3 text-[11px] text-[var(--text-muted)]">
                    暂无录音文件
                  </p>
                ) : (
                  <ul className="divide-y divide-[var(--border)]">
                    {recordings.map((f) => (
                      <li key={f.name}>
                        <button
                          type="button"
                          onClick={() => setSelectedRec(f.name)}
                          className={`flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-[11px] ${
                            selectedRec === f.name
                              ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                              : 'text-[var(--text)] hover:bg-[var(--bg-deep)]'
                          }`}
                        >
                          <span className="min-w-0 truncate font-mono">{f.name}</span>
                          <span className="shrink-0 tabular-nums text-[var(--text-muted)]">
                            {formatBytes(f.size)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="flex min-h-0 flex-col bg-[var(--bg-deep)]">
              <div className="shrink-0 border-b border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-muted)]">
                文件属性
              </div>
              <div className="panel-scroll min-h-0 flex-1 space-y-2 px-3 py-2 text-[11px]">
                {selectedRecording ? (
                  <>
                    <PropRow label="Name" value={selectedRecording.name} />
                    <PropRow
                      label="Type"
                      value={selectedRecording.ext.replace('.', '').toUpperCase() || '—'}
                    />
                    <PropRow label="Size" value={formatBytes(selectedRecording.size)} />
                    <PropRow
                      label="Created"
                      value={formatDate(selectedRecording.birthtimeMs)}
                    />
                    <PropRow
                      label="Duration"
                      value={
                        selectedRecording.ext === '.wav'
                          ? formatDuration(selectedRecording.durationSec)
                          : '—'
                      }
                    />
                  </>
                ) : (
                  <p className="text-[var(--text-muted)]">选择左侧录音以查看属性</p>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* ========== 3. 日志管理 ========== */}
        <section className="flex min-h-0 flex-col overflow-hidden rounded border border-[var(--border)] bg-[var(--bg-panel)]">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-1.5">
            <span className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
              日志管理
            </span>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => void refreshLogs()}
                className="inline-flex h-6 items-center rounded border border-[var(--border)] px-2 text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                刷新列表
              </button>
              <button
                type="button"
                onClick={() => void window.whisperApi?.openSessionLogsDir?.()}
                className="inline-flex h-6 items-center rounded border border-[var(--border)] px-2 text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                打开目录
              </button>
            </div>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-2 gap-0">
            <div className="flex min-h-0 flex-col border-r border-[var(--border)]">
              <div className="shrink-0 border-b border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-muted)]">
                日志列表
              </div>
              <div className="panel-scroll min-h-0 flex-1 overflow-y-auto bg-[var(--bg-elevated)]">
                {logFiles.length === 0 ? (
                  <p className="px-2 py-3 text-[11px] text-[var(--text-muted)]">
                    暂无日志文件
                  </p>
                ) : (
                  <ul className="divide-y divide-[var(--border)]">
                    {logFiles.map((f) => (
                      <li key={f.name}>
                        <button
                          type="button"
                          onClick={() => setSelectedLog(f.name)}
                          className={`flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-[11px] ${
                            selectedLog === f.name
                              ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                              : 'text-[var(--text)] hover:bg-[var(--bg-deep)]'
                          }`}
                        >
                          <span className="min-w-0 truncate font-mono">{f.name}</span>
                          <span className="shrink-0 tabular-nums text-[var(--text-muted)]">
                            {formatBytes(f.size)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="flex min-h-0 flex-col bg-[var(--bg-deep)]">
              <div className="shrink-0 border-b border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-muted)]">
                日志预览
              </div>
              <textarea
                readOnly
                value={logPreview}
                placeholder="选择左侧日志以预览…"
                className="panel-scroll min-h-0 flex-1 resize-none bg-transparent px-2 py-2 text-[11px] leading-relaxed text-[var(--text)] outline-none"
                style={{ fontFamily: LOG_PREVIEW_FONT }}
              />
            </div>
          </div>
        </section>
      </div>

      <AppFooter onOpenSettings={() => setEngineOpen(true)} />
      <EngineSettingsPanel open={engineOpen} onClose={() => setEngineOpen(false)} />
    </div>
  )
}

function PropRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </span>
      <span className="break-all text-[var(--text)]">{value}</span>
    </div>
  )
}

/** Test-page level meter — painted imperatively from meterBus (no re-renders). */
function TestLevelMeter({ active }: { active: boolean }): React.JSX.Element {
  const barRef = useRef<HTMLDivElement>(null)
  const pctRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!active) {
      if (barRef.current) barRef.current.style.width = '0%'
      if (pctRef.current) pctRef.current.textContent = '0%'
      return
    }
    return subscribeMeter((snap) => {
      const pct = Math.min(100, Math.round(snap.inputLevel * 100))
      if (barRef.current) barRef.current.style.width = `${pct}%`
      if (pctRef.current) pctRef.current.textContent = `${pct}%`
    })
  }, [active])

  return (
    <div className="ml-auto flex w-32 flex-col gap-0.5">
      <div className="flex justify-between text-[10px] text-[var(--text-muted)]">
        <span>电平</span>
        <span ref={pctRef} className="tabular-nums">
          0%
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-[var(--bg-deep)]">
        <div
          ref={barRef}
          className="h-full bg-emerald-400 transition-[width] duration-[60ms] ease-linear"
          style={{ width: '0%' }}
        />
      </div>
    </div>
  )
}
