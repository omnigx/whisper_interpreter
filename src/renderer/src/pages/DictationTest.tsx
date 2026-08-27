import { useEffect, useRef, useState } from 'react'
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
import { LanguageTag } from '../components/LanguageTag'

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

interface DictationTestProps {
  onBack?: () => void
}

/**
 * 双引擎本地 STT 测试：SenseVoice 整句 / Paraformer 流式
 */
export function DictationTest({ onBack }: DictationTestProps): React.JSX.Element {
  const storeProvider = useAppStore((s) => s.settings.stt.provider)
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

  const maxDuration = engine === 'sensevoice' ? 15 : 10
  const silenceMs = engine === 'sensevoice' ? 800 : 300

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
      let assembled = ''
      try {
        assembled = await llm.translateStream(
          userContent,
          (chunk) => {
            assembled += chunk
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
          },
          undefined,
          { systemPrompt }
        )
        if (isEchoRepetition(text, assembled)) {
          removeTranslation(id)
          setPipelineStatus('已拦截复读原文的无效译文')
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
        historyRef.current = [...historyRef.current, text].slice(-20)
        setPipelineStatus(
          `翻译完成 · ${reversed ? '反向 ' : ''}${directionLabel(actualDirection)} · ${llm.label}`
        )
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
    inputLevel,
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
    if (isRecording) stopRecording()
    else {
      historyRef.current = []
      void startRecording().catch(() => undefined)
    }
  }

  return (
    <div className="flex h-full flex-col bg-[var(--bg-deep)] text-[var(--text)]">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-panel)] px-4 py-3">
        <div>
          <h1 className="text-base font-semibold">本地 STT 双引擎测试</h1>
          <p className="text-xs text-[var(--text-muted)]">
            {engine === 'sensevoice'
              ? `SenseVoice 整句 · 静音 ${silenceMs}ms / max ${maxDuration}s · 纯文本 → LLM`
              : `Paraformer 流式 · 静音 ${silenceMs}ms / max ${maxDuration}s · JSON partial/final`}
          </p>
        </div>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="rounded border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            返回主界面
          </button>
        )}
      </header>

      <div className="flex shrink-0 flex-wrap items-end gap-3 border-b border-[var(--border)] bg-[var(--bg-panel)]/80 px-4 py-3">
        <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
          引擎
          <select
            className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text)]"
            value={engine}
            onChange={(e) => switchEngine(e.target.value as LocalSttEngine)}
          >
            <option value="sensevoice">本地 SenseVoice（稳定/抗噪）</option>
            <option value="paraformer">本地 Paraformer（极速流式）</option>
          </select>
        </label>

        <label className="flex min-w-[280px] flex-1 flex-col gap-1 text-xs text-[var(--text-muted)]">
          WebSocket URL
          <div className="flex gap-2">
            <input
              type="text"
              value={wsUrlInput}
              onChange={(e) => setWsUrlInput(e.target.value)}
              className="flex-1 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 font-mono text-sm text-[var(--text)]"
            />
            <button
              type="button"
              onClick={applyUrl}
              className="rounded border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              应用
            </button>
          </div>
        </label>

        <button
          type="button"
          onClick={toggle}
          className={`rounded px-4 py-2 text-sm font-medium transition ${
            isRecording
              ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
              : 'bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--accent)]/25'
          }`}
        >
          {isRecording ? '停止录音' : '开始录音'}
        </button>

        <button
          type="button"
          onClick={() => {
            clearTranscripts()
            historyRef.current = []
          }}
          className="rounded border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          清空转写
        </button>

        <span className="inline-flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{
              backgroundColor: STATUS_COLOR[connectionStatus],
              boxShadow:
                connectionStatus === 'connected'
                  ? `0 0 8px ${STATUS_COLOR.connected}`
                  : undefined
            }}
          />
          {STATUS_LABEL[connectionStatus]}
        </span>

        <div className="ml-auto flex min-w-[140px] flex-col gap-1">
          <div className="flex justify-between text-[10px] text-[var(--text-muted)]">
            <span>电平</span>
            <span>{Math.round(inputLevel * 100)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-[var(--bg-deep)]">
            <div
              className="h-full bg-emerald-400 transition-[width] duration-75"
              style={{ width: `${Math.min(100, Math.round(inputLevel * 100))}%` }}
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div ref={listRef} className="panel-scroll min-h-0 flex-1 space-y-3 px-4 py-4">
        {finalTranscripts.length === 0 && !partialText ? (
          <p className="text-sm text-[var(--text-muted)]/70">
            SenseVoice：静音 800ms / 15s 整句发送，纯文本上屏并翻译。Paraformer：灰字
            partial + 黑字 final。
          </p>
        ) : (
          <>
            {finalTranscripts.map((line, i) => (
              <div
                key={`${i}-${line.slice(0, 12)}`}
                className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2"
              >
                <div className="mb-1 text-[10px] text-[var(--text-muted)]">#{i + 1} final</div>
                <p className="leading-relaxed text-[var(--text)]">
                  <LanguageTag lang={detectLanguage(line)} />
                  {line}
                </p>
              </div>
            ))}
            {partialText ? (
              <div className="rounded bg-sky-500/15 px-3 py-2">
                <div className="mb-1 text-[10px] text-sky-300/80">partial</div>
                <p className="leading-relaxed text-[var(--text-muted)] italic">
                  <LanguageTag lang={detectLanguage(partialText)} />
                  {partialText}
                  <span className="ml-1 inline-block h-3 w-0.5 animate-pulse bg-sky-400 align-middle" />
                </p>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
