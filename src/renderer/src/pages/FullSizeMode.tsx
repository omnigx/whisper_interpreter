import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useAppStore } from '../stores/appStore'
import { AudioControlPanel } from '../components/AudioControlPanel'
import { AppFooter } from '../components/AppFooter'
import { EngineSettingsPanel } from '../components/EngineSettingsPanel'
import { HeaderDisplaySettings } from '../components/HeaderDisplaySettings'
import { HeaderEngineSettings } from '../components/HeaderEngineSettings'
import { HeaderInputSource } from '../components/HeaderInputSource'
import { HeaderRecordingSettings } from '../components/HeaderRecordingSettings'
import { LanguageTag } from '../components/LanguageTag'
import { TermsPanel } from '../components/TermsPanel'
import { WindowControls } from '../components/WindowControls'
import { useAudioPipeline } from '../hooks/useAudioPipeline'
import { useContentWheelZoom } from '../hooks/useContentWheelZoom'
import { useAsyncTermExtraction } from '../hooks/useAsyncTermExtraction'
import { useTermMatcher } from '../hooks/useTermMatcher'
import { DictationTest } from './DictationTest'
import {
  defaultSttModel,
  defaultSttWebsocketUrl,
  getActiveLlm,
  LLM_NONE_ID,
  type SttProviderKind,
  type TranslationDirection
} from '@shared/types'
import { detectLanguage } from '../utils/detectLanguage'
import {
  DEFAULT_CHINESE_FONT,
  DEFAULT_WESTERN_FONT,
  buildContentFontFamily
} from '../utils/contentFonts'
import {
  BrainIcon,
  MicIcon,
  PanelQuickMenu,
  QuickMenuItem
} from '../components/PanelQuickMenu'

interface FullSizeModeProps {
  /** Independent subtitle BrowserWindow is open */
  subtitleOpen?: boolean
  onToggleSubtitle?: () => void
}

export function FullSizeMode({
  subtitleOpen = false,
  onToggleSubtitle
}: FullSizeModeProps): React.JSX.Element {
  const transcripts = useAppStore((s) => s.transcripts)
  const partialText = useAppStore((s) => s.partialText)
  const translations = useAppStore((s) => s.translations)
  const isListening = useAppStore((s) => s.isListening)
  const sttLinkStatus = useAppStore((s) => s.sttLinkStatus)
  const pipelineStatus = useAppStore((s) => s.pipelineStatus)
  const seedDemoContent = useAppStore((s) => s.seedDemoContent)
  const clearSession = useAppStore((s) => s.clearSession)
  const settings = useAppStore((s) => s.settings)
  const setTranslationDirection = useAppStore((s) => s.setTranslationDirection)
  const setStt = useAppStore((s) => s.setStt)
  const setActiveLlm = useAppStore((s) => s.setActiveLlm)
  const updateLlm = useAppStore((s) => s.updateLlm)
  const translationDirection = settings.translationDirection ?? 'en-zh'

  const [engineOpen, setEngineOpen] = useState(false)
  const [showDictationTest, setShowDictationTest] = useState(false)

  const {
    devices,
    refreshDevices,
    vadSegmentCount,
    vadEngine,
    startListening,
    stopListening,
    restartListening,
    setGainLive,
    setMaxSentenceLive,
    setSilenceLive,
    setInputSourceLive,
    setDeviceLive,
    setSyncRecordingLive
  } = useAudioPipeline()

  const sourceRef = useRef<HTMLDivElement>(null)
  const targetRef = useRef<HTMLDivElement>(null)
  const termsRef = useRef<HTMLDivElement>(null)

  const activeLlm = getActiveLlm(settings)
  const llmDisabled = settings.engine.activeLlmId === LLM_NONE_ID || !activeLlm

  const STT_QUICK: Array<{ value: SttProviderKind; label: string }> = [
    { value: 'local-sensevoice', label: 'SenseVoice' },
    { value: 'local-paraformer', label: 'Paraformer' },
    { value: 'faster-whisper-medium', label: 'FW Medium' },
    { value: 'faster-whisper-large-v3', label: 'FW Large-v3' }
  ]

  const selectStt = (provider: SttProviderKind): void => {
    const url = defaultSttWebsocketUrl(provider)
    setStt({
      provider,
      ...(url ? { websocketUrl: url } : {}),
      model: defaultSttModel(provider) || settings.stt.model
    })
  }

  const selectLlm = (id: string, model?: string): void => {
    if (id === LLM_NONE_ID) {
      setActiveLlm(LLM_NONE_ID)
      return
    }
    setActiveLlm(id)
    if (model) updateLlm(id, { model })
  }
  const display = settings.display
  const lineHeight = display.lineHeight ?? 1
  const contentFontSize = Math.round(display.fontSize * (display.zoomScale || 1))
  const contentFontFamily = buildContentFontFamily(
    display.westernFont || DEFAULT_WESTERN_FONT,
    display.chineseFont || DEFAULT_CHINESE_FONT
  )
  const contentPanelStyle: CSSProperties = {
    fontSize: `${contentFontSize}px`,
    fontFamily: contentFontFamily
  }
  const textLineStyle: CSSProperties = {
    lineHeight,
    fontFamily: contentFontFamily
  }
  const foreignTermStyle: CSSProperties = {
    lineHeight,
    fontFamily: display.westernFont || DEFAULT_WESTERN_FONT
  }
  const chineseTermStyle: CSSProperties = {
    lineHeight,
    fontFamily: display.chineseFont || DEFAULT_CHINESE_FONT
  }
  const itemGapStyle: CSSProperties = {
    marginBottom: `calc(${lineHeight} * 0.6em)`
  }

  useContentWheelZoom(sourceRef, targetRef, termsRef)
  const { importCsvFile, glossaryCount, lastError } = useTermMatcher()
  useAsyncTermExtraction()
  const isLlmExtractionEnabled = useAppStore((s) => s.isLlmExtractionEnabled)
  const setLlmExtractionEnabled = useAppStore((s) => s.setLlmExtractionEnabled)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    sourceRef.current?.scrollTo({ top: sourceRef.current.scrollHeight, behavior: 'smooth' })
  }, [transcripts, partialText])

  useEffect(() => {
    targetRef.current?.scrollTo({ top: targetRef.current.scrollHeight, behavior: 'smooth' })
  }, [translations])

  const toggleListen = (): void => {
    if (isListening) stopListening()
    else void startListening()
  }

  if (showDictationTest) {
    return <DictationTest onBack={() => setShowDictationTest(false)} />
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--bg-deep)]">
      <header className="drag-region flex h-12 shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-panel)] pl-4 pr-1">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-wide text-[var(--text)]">
              Whisper Interpreter
            </h1>
            <p className="truncate text-[10px] text-[var(--text-muted)]">{pipelineStatus}</p>
          </div>
          <span
            className={`inline-flex h-2 w-2 shrink-0 rounded-full ${
              isListening ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]' : 'bg-slate-500'
            }`}
          />
        </div>

        <div className="no-drag flex h-8 shrink-0 items-center gap-1.5" style={{ WebkitAppRegion: 'no-drag' }}>
          <div
            className="inline-flex h-8 items-center rounded border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5"
            role="group"
            aria-label="主翻译方向"
          >
            {(
              [
                { value: 'en-zh' as TranslationDirection, label: '英译中' },
                { value: 'zh-en' as TranslationDirection, label: '中译英' }
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setTranslationDirection(opt.value)}
                className={`inline-flex h-7 items-center whitespace-nowrap rounded px-2.5 text-xs font-medium transition ${
                  translationDirection === opt.value
                    ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}
                title={opt.value === 'en-zh' ? 'EN → ZH · Auto-LID' : 'ZH → EN · Auto-LID'}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={toggleListen}
            className={`inline-flex h-8 items-center whitespace-nowrap rounded px-2.5 text-xs font-medium transition ${
              isListening
                ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
                : 'bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--accent)]/25'
            }`}
          >
            {isListening ? '停止听写' : '开始听写'}
          </button>

          <button
            type="button"
            onClick={() => onToggleSubtitle?.()}
            className={`inline-flex h-8 items-center whitespace-nowrap rounded border px-2.5 text-xs transition ${
              subtitleOpen
                ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text)] hover:border-[var(--accent)]'
            }`}
            title="打开/关闭独立悬浮字幕窗口"
          >
            字幕
          </button>

          <button
            type="button"
            onClick={() => setShowDictationTest(true)}
            className="inline-flex h-8 items-center whitespace-nowrap rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 text-xs text-[var(--text)] hover:border-[var(--accent)]"
          >
            测试
          </button>

          <button
            type="button"
            onClick={seedDemoContent}
            className="inline-flex h-8 items-center whitespace-nowrap rounded border border-[var(--border)] px-2.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            演示
          </button>

          <button
            type="button"
            onClick={clearSession}
            className="inline-flex h-8 items-center whitespace-nowrap rounded border border-[var(--border)] px-2.5 text-xs text-[var(--text-muted)] hover:text-[var(--danger)]"
          >
            清空
          </button>

          <HeaderRecordingSettings
            onSyncRecordingChange={(enabled) => void setSyncRecordingLive(enabled)}
          />
          <HeaderInputSource
            devices={devices}
            onDevice={(id) => void setDeviceLive(id)}
            onRefreshDevices={() => void refreshDevices()}
            onInputSource={(mode) => void setInputSourceLive(mode)}
          />
          <HeaderEngineSettings />
          <HeaderDisplaySettings />
          <WindowControls />
        </div>
      </header>

      <AudioControlPanel
        vadSegmentCount={vadSegmentCount}
        vadEngine={vadEngine}
        onGain={setGainLive}
        onMaxSentence={setMaxSentenceLive}
        onSilence={setSilenceLive}
      />

      {isListening &&
      (sttLinkStatus === 'disconnected' || sttLinkStatus === 'reconnecting') ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-xs text-amber-100">
          <span className="min-w-0 truncate">
            {sttLinkStatus === 'reconnecting'
              ? 'SenseVoice / STT 已断开，正在自动重连…'
              : 'SenseVoice / STT 连接已断开。请确认 1_sensevoice.bat 仍在运行。'}
          </span>
          <button
            type="button"
            className="shrink-0 rounded border border-amber-400/50 bg-amber-500/20 px-2.5 py-1 text-[11px] font-medium text-amber-50 hover:bg-amber-500/30"
            onClick={() => void restartListening()}
          >
            重新连接
          </button>
        </div>
      ) : null}

      <main className="flex min-h-0 flex-1">
        <section className="flex w-1/2 min-w-0 flex-col border-r border-[var(--border)]">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2">
            <span className="text-xs font-medium uppercase tracking-wider text-[var(--source)]">
              源语言转写
            </span>
            <PanelQuickMenu label="切换 STT" title="快速切换 STT 引擎" icon={<MicIcon />}>
              {STT_QUICK.map((p) => (
                <QuickMenuItem
                  key={p.value}
                  active={
                    settings.stt.provider === p.value ||
                    (p.value === 'faster-whisper-medium' &&
                      (settings.stt.provider === 'faster-whisper' ||
                        settings.stt.provider === 'local-faster-whisper'))
                  }
                  onClick={() => selectStt(p.value)}
                >
                  {p.label}
                </QuickMenuItem>
              ))}
            </PanelQuickMenu>
          </div>
          <div
            ref={sourceRef}
            className="panel-scroll min-h-0 flex-1 px-4 py-3"
            style={contentPanelStyle}
            title="Ctrl + 滚轮调节字号"
          >
            {transcripts.length === 0 && !partialText ? (
              <EmptyHint text="开始听写后，SenseVoice 整句（黑字）或 Paraformer partial（灰）/ final（实）将显示于此；定稿立即送 LLM。" />
            ) : (
              <>
                {transcripts.map((t) => (
                  <div key={t.id} className="text-[var(--text)]" style={itemGapStyle}>
                    <LanguageTag lang={t.lang ?? detectLanguage(t.text)} />
                    <span className="text-content whitespace-pre-wrap break-words" style={textLineStyle}>
                      {t.text}
                    </span>
                  </div>
                ))}
                {partialText ? (
                  <div
                    className="rounded bg-sky-500/15 px-2 py-1 text-[var(--text-muted)] italic"
                    style={itemGapStyle}
                  >
                    <LanguageTag lang={detectLanguage(partialText)} />
                    <span className="text-content whitespace-pre-wrap break-words" style={textLineStyle}>
                      {partialText}
                    </span>
                    <span className="ml-1 inline-block h-3 w-0.5 animate-pulse bg-sky-400 align-middle" />
                  </div>
                ) : null}
              </>
            )}
          </div>
        </section>

        <section className="flex w-1/2 min-w-0 flex-col">
          <div className="flex min-h-0 flex-[0.7] flex-col border-b border-[var(--border)]">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2">
              <span className="min-w-0 truncate text-xs font-medium uppercase tracking-wider text-[var(--target)]">
                目标语言翻译
                {llmDisabled
                  ? ' · N/A'
                  : activeLlm
                    ? ` · ${activeLlm.model}`
                    : ''}
              </span>
              <PanelQuickMenu
                label="切换 LLM"
                title="快速切换 LLM"
                icon={<BrainIcon />}
                accentClass="hover:border-[var(--target)] hover:text-[var(--target)]"
              >
                <QuickMenuItem
                  active={llmDisabled}
                  onClick={() => selectLlm(LLM_NONE_ID)}
                >
                  N/A (不启用)
                </QuickMenuItem>
                {settings.llms.flatMap((l) => {
                  if (l.provider === 'ollama') {
                    return ['qwen2.5:7b', 'qwen2.5:14b', l.model]
                      .filter((v, i, a) => a.indexOf(v) === i)
                      .map((m) => (
                        <QuickMenuItem
                          key={`${l.id}-${m}`}
                          active={!llmDisabled && activeLlm?.id === l.id && activeLlm.model === m}
                          onClick={() => selectLlm(l.id, m)}
                        >
                          [本地] {m}
                        </QuickMenuItem>
                      ))
                  }
                  return [
                    <QuickMenuItem
                      key={l.id}
                      active={!llmDisabled && activeLlm?.id === l.id}
                      onClick={() => selectLlm(l.id)}
                    >
                      [{l.tier === 'cloud' ? '云' : '本地'}] {l.label}
                    </QuickMenuItem>
                  ]
                })}
              </PanelQuickMenu>
            </div>
            <div
              ref={targetRef}
              className="panel-scroll min-h-0 flex-1 px-4 py-3"
              style={contentPanelStyle}
              title="Ctrl + 滚轮调节字号"
            >
              {llmDisabled ? (
                <div className="flex h-full min-h-[120px] items-center justify-center px-4">
                  <p className="text-center text-sm text-[var(--text-muted)]/70">
                    目标语言翻译已关闭
                  </p>
                </div>
              ) : translations.length === 0 ? (
                <EmptyHint text="上下文重组后的句子将经统一 LLM 适配层流式翻译（DeepSeek / Gemini / Ollama 等）。" />
              ) : (
                translations.map((t) =>
                  t.type === 'system' ? (
                    <div
                      key={t.id}
                      className="py-1 text-center text-sm italic text-white/40"
                      style={itemGapStyle}
                    >
                      {t.text}
                    </div>
                  ) : (
                    <div
                      key={t.id}
                      className={
                        t.streaming ? 'text-[var(--target)]/80' : 'text-[var(--target)]'
                      }
                      style={itemGapStyle}
                    >
                      <LanguageTag lang={t.lang} />
                      <span
                        className="text-content whitespace-pre-wrap break-words"
                        style={textLineStyle}
                      >
                        {t.text}
                      </span>
                      {t.streaming && <span className="ml-1 animate-pulse">▍</span>}
                    </div>
                  )
                )
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-[0.3] flex-col">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-wider text-[var(--term)]">
                  专业术语（异步）
                </span>
                {glossaryCount > 0 ? (
                  <span className="truncate text-[10px] text-[var(--text-muted)]">
                    词表 {glossaryCount}
                  </span>
                ) : null}
                {lastError ? (
                  <span className="truncate text-[10px] text-[var(--danger)]" title={lastError}>
                    导入异常
                  </span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  title={
                    isLlmExtractionEnabled
                      ? '关闭 AI 智能提取'
                      : '开启 AI 智能提取'
                  }
                  aria-label={
                    isLlmExtractionEnabled
                      ? '关闭 AI 智能提取'
                      : '开启 AI 智能提取'
                  }
                  aria-pressed={isLlmExtractionEnabled}
                  className={`inline-flex h-6 w-6 items-center justify-center rounded border transition ${
                    isLlmExtractionEnabled
                      ? 'border-[var(--term)] bg-[var(--term)]/15 text-[var(--term)]'
                      : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--term)] hover:text-[var(--term)]'
                  }`}
                  onClick={() =>
                    setLlmExtractionEnabled(!isLlmExtractionEnabled)
                  }
                >
                  <LlmExtractIcon />
                </button>
                <button
                  type="button"
                  title="导入 CSV 术语表（第 1 列外文，第 2 列中文）"
                  aria-label="导入 CSV 术语表"
                  className="inline-flex h-6 w-6 items-center justify-center rounded border border-[var(--border)] text-[var(--text-muted)] transition hover:border-[var(--term)] hover:text-[var(--term)]"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <CsvImportIcon />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) importCsvFile(file)
                    e.target.value = ''
                  }}
                />
              </div>
            </div>
            <TermsPanel
              scrollRef={termsRef}
              contentPanelStyle={contentPanelStyle}
              foreignTextStyle={foreignTermStyle}
              chineseTextStyle={chineseTermStyle}
            />
          </div>
        </section>
      </main>

      <AppFooter
        onOpenSettings={() => setEngineOpen(true)}
        onRestartListening={() => void restartListening()}
      />

      <EngineSettingsPanel open={engineOpen} onClose={() => setEngineOpen(false)} />
    </div>
  )
}

function EmptyHint({ text }: { text: string }): React.JSX.Element {
  return <p className="text-sm text-[var(--text-muted)]/70">{text}</p>
}

function CsvImportIcon(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M12 18v-6" />
      <path d="M9 15h6" />
    </svg>
  )
}

function LlmExtractIcon(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  )
}
