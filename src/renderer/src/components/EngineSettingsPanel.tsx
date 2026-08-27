import { useEffect, useState } from 'react'
import {
  defaultSttModel,
  defaultSttWebsocketUrl,
  derivePipelineMode,
  getActiveLlm,
  isFasterWhisperStt,
  LLM_NONE_ID,
  pipelineModeLabel,
  type PipelineModePreset,
  type SttConfig,
  type SttProviderKind
} from '@shared/types'
import {
  fetchOllamaModels,
  pickPreferredOllamaModel
} from '../services/llm'
import {
  applyProviderApiKeyToStore,
  loadProviderApiKey,
  saveProviderApiKey
} from '../services/secureApiKeys'
import {
  resetEngineToDefaults,
  restoreEngineConfig,
  saveCurrentEngineConfig
} from '../services/enginePersistence'
import { useAppStore } from '../stores/appStore'

const STT_PROVIDERS: Array<{ value: SttProviderKind; label: string; tier: 'cloud' | 'local' }> =
  [
    { value: 'local-sensevoice', label: '本地 SenseVoice（稳定/抗噪）· 默认', tier: 'local' },
    { value: 'local-paraformer', label: '本地 Paraformer（极速流式）', tier: 'local' },
    { value: 'faster-whisper-medium', label: 'Faster-Whisper (Medium)', tier: 'local' },
    { value: 'faster-whisper-large-v3', label: 'Faster-Whisper (Large-v3)', tier: 'local' },
    { value: 'deepgram', label: 'Deepgram', tier: 'cloud' },
    { value: 'azure', label: 'Azure Speech', tier: 'cloud' },
    { value: 'aliyun', label: '阿里云', tier: 'cloud' }
  ]

const PRESETS: Array<{ value: PipelineModePreset; label: string; desc: string }> = [
  { value: 'cloud', label: '全在线', desc: '云端 STT + 云端 LLM' },
  { value: 'offline', label: '全离线', desc: '本地 STT + Ollama/本地 LLM' },
  { value: 'hybrid-cloud-stt', label: '混合 A', desc: '在线 STT + 本地 LLM' },
  { value: 'hybrid-local-stt', label: '混合 B', desc: '本地 STT + 云端 LLM' }
]

/** Fallback options when Ollama /api/tags is unreachable */
const OLLAMA_FALLBACK_MODELS = ['qwen2.5:7b', 'qwen2.5:14b']

interface EngineSettingsPanelProps {
  open: boolean
  onClose: () => void
}

export function EngineSettingsPanel({
  open,
  onClose
}: EngineSettingsPanelProps): React.JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const isListening = useAppStore((s) => s.isListening)
  const setStt = useAppStore((s) => s.setStt)
  const setEngine = useAppStore((s) => s.setEngine)
  const updateLlm = useAppStore((s) => s.updateLlm)
  const setActiveLlm = useAppStore((s) => s.setActiveLlm)
  const applyPipelinePreset = useAppStore((s) => s.applyPipelinePreset)
  const degradeToOffline = useAppStore((s) => s.degradeToOffline)

  const activeLlm = getActiveLlm(settings)
  const selectedLLM = activeLlm?.model ?? ''

  const [availableModels, setAvailableModels] = useState<string[]>([
    ...OLLAMA_FALLBACK_MODELS
  ])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [modelsFetchKey, setModelsFetchKey] = useState(0)
  const [keySaveHint, setKeySaveHint] = useState<string | null>(null)
  const [persistHint, setPersistHint] = useState<string | null>(null)

  const OLLAMA_FALLBACK_OPTIONS = [
    ...new Set([
      ...OLLAMA_FALLBACK_MODELS,
      ...availableModels,
      ...(settings.llms.find((l) => l.provider === 'ollama')?.model
        ? [settings.llms.find((l) => l.provider === 'ollama')!.model]
        : [])
    ])
  ]

  const fallbackSelectValue =
    settings.engine.fallbackLlmId === LLM_NONE_ID || !settings.engine.fallbackLlmId
      ? LLM_NONE_ID
      : settings.engine.fallbackLlmId === 'ollama-qwen' ||
          settings.llms.find((l) => l.id === settings.engine.fallbackLlmId)
            ?.provider === 'ollama'
        ? `${settings.engine.fallbackLlmId}::${settings.engine.fallbackLlmModel || settings.llms.find((l) => l.id === settings.engine.fallbackLlmId)?.model || 'qwen2.5:7b'}`
        : settings.engine.fallbackLlmId

  const onFallbackChange = (raw: string): void => {
    if (raw === LLM_NONE_ID) {
      setEngine({ fallbackLlmId: LLM_NONE_ID, fallbackLlmModel: undefined })
      return
    }
    if (raw.includes('::')) {
      const [id, model] = raw.split('::')
      setEngine({ fallbackLlmId: id, fallbackLlmModel: model })
      return
    }
    setEngine({ fallbackLlmId: raw, fallbackLlmModel: undefined })
  }

  const handleSave = (): void => {
    const ok = saveCurrentEngineConfig()
    setPersistHint(ok ? '已保存' : '保存失败')
    window.setTimeout(() => setPersistHint(null), 1000)
  }

  const handleRestore = (): void => {
    const ok = restoreEngineConfig()
    setPersistHint(ok ? '已恢复' : '无保存配置')
    window.setTimeout(() => setPersistHint(null), 1000)
  }

  const handleDefault = (): void => {
    resetEngineToDefaults()
    setPersistHint('已重置默认')
    window.setTimeout(() => setPersistHint(null), 1000)
  }

  // Auto-fill cloud API keys from OS-encrypted vault when panel opens / endpoint changes
  useEffect(() => {
    if (!open || !activeLlm || activeLlm.provider === 'ollama') return
    let cancelled = false
    void (async () => {
      const key = await loadProviderApiKey(activeLlm.provider)
      if (cancelled || !key) return
      applyProviderApiKeyToStore(activeLlm.provider, key)
    })()
    return () => {
      cancelled = true
    }
  }, [open, activeLlm?.id, activeLlm?.provider])

  useEffect(() => {
    if (!open || !activeLlm || activeLlm.provider !== 'ollama') {
      return
    }

    const controller = new AbortController()
    let timedOut = false
    const timer = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 4000)
    setModelsLoading(true)
    setModelsError(null)

    void (async () => {
      try {
        const names = await fetchOllamaModels(activeLlm.baseUrl, controller.signal)
        if (controller.signal.aborted) return

        // API tags first; always append missing fallback so 7b/14b stay visible
        const fromApiFirst = [
          ...names,
          ...OLLAMA_FALLBACK_MODELS.filter((n) => !names.includes(n))
        ]
        setAvailableModels(fromApiFirst)

        const preferred = pickPreferredOllamaModel(fromApiFirst, activeLlm.model)
        if (
          preferred &&
          preferred !== activeLlm.model &&
          (!activeLlm.model || !fromApiFirst.includes(activeLlm.model))
        ) {
          updateLlm(activeLlm.id, { model: preferred })
        }
      } catch (e) {
        if (controller.signal.aborted) {
          if (timedOut) {
            setAvailableModels((prev) =>
              prev.length > 0 ? prev : [...OLLAMA_FALLBACK_MODELS]
            )
            setModelsError('拉取超时，已显示常用模型 qwen2.5:7b / 14b')
          }
          return
        }
        setAvailableModels([...OLLAMA_FALLBACK_MODELS])
        setModelsError(e instanceof Error ? e.message : String(e))
      } finally {
        window.clearTimeout(timer)
        setModelsLoading(false)
      }
    })()

    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [
    open,
    activeLlm?.id,
    activeLlm?.provider,
    activeLlm?.baseUrl,
    updateLlm,
    modelsFetchKey
  ])

  if (!open) return null

  const mode = derivePipelineMode(settings.stt, activeLlm)
  const patchStt = (partial: Partial<SttConfig>): void => setStt(partial)
  const selectSttProvider = (provider: SttProviderKind): void => {
    const url = defaultSttWebsocketUrl(provider)
    patchStt({
      provider,
      ...(url ? { websocketUrl: url } : {}),
      model: defaultSttModel(provider) || settings.stt.model
    })
  }
  const fallbackLlm = settings.llms.find((l) => l.id === settings.engine.fallbackLlmId)
  const isOllama = activeLlm?.provider === 'ollama'
  const modelOptions = isOllama
    ? [
        ...new Set([
          ...availableModels,
          ...OLLAMA_FALLBACK_MODELS,
          ...(selectedLLM ? [selectedLLM] : [])
        ])
      ]
    : []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text)]">引擎设置</h2>
            <p className="text-xs text-[var(--text-muted)]">
              当前：{pipelineModeLabel(mode)} · STT {settings.stt.provider} · LLM{' '}
              {activeLlm?.label ?? '—'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-[var(--text-muted)] hover:bg-[var(--bg-elevated)]"
          >
            关闭
          </button>
        </div>

        <div className="panel-scroll space-y-5 overflow-y-auto px-4 py-4">
          {isListening && (
            <p className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              听写进行中。切换 STT 引擎会自动断开并重连到新端口；切换 Ollama
              模型将在下一次翻译立即生效。
            </p>
          )}

          {/* Presets */}
          <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
              流水线模式
            </h3>
            <div className="grid grid-cols-2 gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => applyPipelinePreset(p.value)}
                  className={`rounded border px-3 py-2 text-left transition ${
                    mode === p.value
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-[var(--border)] bg-[var(--bg-elevated)] hover:border-[var(--accent)]/50'
                  }`}
                >
                  <div className="text-sm text-[var(--text)]">{p.label}</div>
                  <div className="text-[10px] text-[var(--text-muted)]">{p.desc}</div>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => degradeToOffline()}
              className="mt-2 w-full rounded border border-orange-500/40 bg-orange-500/10 px-3 py-2 text-xs text-orange-200 hover:bg-orange-500/20"
            >
              一键降级 → 全离线（本地 STT + 本地 LLM）
            </button>
          </section>

          {/* STT */}
          <section className="space-y-3">
            <h3 className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
              STT 引擎
            </h3>
            <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
              Provider
              <select
                className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text)]"
                value={
                  settings.stt.provider === 'local-faster-whisper' ||
                  settings.stt.provider === 'faster-whisper'
                    ? 'faster-whisper-medium'
                    : settings.stt.provider
                }
                onChange={(e) => selectSttProvider(e.target.value as SttProviderKind)}
              >
                {STT_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    [{p.tier === 'cloud' ? '云' : '本地'}] {p.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-[10px] text-[var(--text-muted)]">
              {settings.stt.provider === 'local-paraformer'
                ? 'Paraformer：~200ms 流式 + partial/final JSON + is_final（默认 ws://127.0.0.1:8766）'
                : isFasterWhisperStt(settings.stt.provider)
                  ? 'Faster-Whisper：共用 8767 · Medium/Large-v3 可热切换（Silero 整句 Float32）'
                  : settings.stt.provider === 'local-sensevoice'
                    ? 'SenseVoice：VAD 整句缓冲发送，纯文本回包即翻译（默认 ws://127.0.0.1:8765）'
                    : '云端流式 STT'}
            </p>
            <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
              WebSocket URL
              <input
                type="text"
                className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 font-mono text-sm text-[var(--text)]"
                value={settings.stt.websocketUrl}
                placeholder={
                  defaultSttWebsocketUrl(settings.stt.provider) || 'wss://…'
                }
                onChange={(e) => patchStt({ websocketUrl: e.target.value })}
              />
            </label>
            {(settings.stt.provider === 'deepgram' ||
              settings.stt.provider === 'azure' ||
              settings.stt.provider === 'aliyun') && (
              <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                API Key
                <input
                  type="password"
                  className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text)]"
                  value={settings.stt.apiKey}
                  onChange={(e) => patchStt({ apiKey: e.target.value })}
                />
              </label>
            )}
          </section>

          {/* Active LLM */}
          <section className="space-y-3">
            <h3 className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
              激活的 LLM（统一 OpenAI 兼容接口）
            </h3>
                <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                  LLM 端点
                  <select
                    className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text)]"
                    value={
                      settings.engine.activeLlmId === LLM_NONE_ID
                        ? LLM_NONE_ID
                        : settings.engine.activeLlmId
                    }
                    onChange={(e) => setActiveLlm(e.target.value)}
                  >
                    <option value={LLM_NONE_ID}>N/A (不启用)</option>
                    {settings.llms.map((l) => (
                      <option key={l.id} value={l.id}>
                        [{l.tier === 'cloud' ? '云' : '本地'}] {l.label}
                        {l.provider === 'ollama' ? '（下方可选 7b / 14b）' : ` · ${l.model}`}
                      </option>
                    ))}
                  </select>
                </label>

            {activeLlm && settings.engine.activeLlmId !== LLM_NONE_ID && (
              <div className="space-y-3 rounded border border-[var(--border)] bg-[var(--bg-deep)] p-3">
                <p className="text-[10px] text-[var(--text-muted)]">
                  编辑「{activeLlm.label}」端点 · Provider: {activeLlm.provider}
                </p>
                <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                  Base URL
                  <input
                    type="text"
                    className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 font-mono text-sm text-[var(--text)]"
                    value={activeLlm.baseUrl}
                    onChange={(e) => updateLlm(activeLlm.id, { baseUrl: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                  API Key
                  <input
                    type="password"
                    autoComplete="off"
                    className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text)]"
                    value={activeLlm.apiKey}
                    placeholder={
                      activeLlm.provider === 'ollama'
                        ? 'ollama（可任意）'
                        : '失焦后自动加密保存到本机'
                    }
                    onChange={(e) => updateLlm(activeLlm.id, { apiKey: e.target.value })}
                    onBlur={() => {
                      if (activeLlm.provider === 'ollama') return
                      const key = activeLlm.apiKey
                      void (async () => {
                        const ok = await saveProviderApiKey(activeLlm.provider, key)
                        if (ok) {
                          applyProviderApiKeyToStore(activeLlm.provider, key.trim())
                          setKeySaveHint(
                            key.trim()
                              ? `已加密保存 ${activeLlm.provider} API Key`
                              : `已清除 ${activeLlm.provider} 本地密钥`
                          )
                          window.setTimeout(() => setKeySaveHint(null), 2200)
                        } else {
                          setKeySaveHint('密钥保存失败（主进程桥接不可用）')
                          window.setTimeout(() => setKeySaveHint(null), 2200)
                        }
                      })()
                    }}
                  />
                  {keySaveHint ? (
                    <span className="text-[10px] text-[var(--accent)]">{keySaveHint}</span>
                  ) : (
                    <span className="text-[10px] text-[var(--text-muted)]/70">
                      使用系统 safeStorage 加密；同 provider（如 DeepSeek Flash/Pro）共用一把 Key
                    </span>
                  )}
                </label>
                <div className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                  <div className="flex items-center justify-between gap-2">
                    <span>当前模型</span>
                    {isOllama && (
                      <button
                        type="button"
                        className="text-[10px] text-[var(--accent)] hover:underline"
                        disabled={modelsLoading}
                        onClick={() => setModelsFetchKey((k) => k + 1)}
                      >
                        {modelsLoading ? '拉取中…' : '刷新列表'}
                      </button>
                    )}
                  </div>
                  {isOllama ? (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        {modelOptions.map((name) => {
                          const active = selectedLLM === name
                          return (
                            <button
                              key={name}
                              type="button"
                              onClick={() => updateLlm(activeLlm.id, { model: name })}
                              className={`rounded border px-3 py-2 text-left font-mono text-sm transition ${
                                active
                                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                                  : 'border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text)] hover:border-[var(--accent)]/50'
                              }`}
                            >
                              {name}
                            </button>
                          )
                        })}
                      </div>
                      <span className="text-[10px] text-[var(--text-muted)]">
                        {modelsLoading
                          ? '正在从 Ollama /api/tags 拉取…'
                          : modelsError
                            ? `拉取异常：${modelsError}（仍可手动选 7b / 14b）`
                            : `本地已发现 ${availableModels.length} 个标签 · 点击切换，下次翻译立即生效`}
                      </span>
                    </>
                  ) : (
                    <input
                      type="text"
                      className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text)]"
                      value={activeLlm.model}
                      placeholder="deepseek-v4-flash / gemini-2.0-flash"
                      onChange={(e) => updateLlm(activeLlm.id, { model: e.target.value })}
                    />
                  )}
                </div>
                <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                  系统提示词
                  <textarea
                    rows={3}
                    className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text)]"
                    value={activeLlm.systemPrompt}
                    onChange={(e) => updateLlm(activeLlm.id, { systemPrompt: e.target.value })}
                  />
                </label>
              </div>
            )}
          </section>

          {/* Fallback */}
          <section className="space-y-3">
            <h3 className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
              离线降级目标
            </h3>
            <label className="flex items-center gap-2 text-xs text-[var(--text)]">
              <input
                type="checkbox"
                checked={settings.engine.autoDegrade}
                onChange={(e) => setEngine({ autoDegrade: e.target.checked })}
              />
              云端不可达时自动降级到本地引擎
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
              降级 LLM
              <select
                className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text)]"
                value={fallbackSelectValue}
                onChange={(e) => onFallbackChange(e.target.value)}
              >
                <option value={LLM_NONE_ID}>N/A (不降级，直接关闭)</option>
                {settings.llms
                  .filter((l) => l.tier === 'local')
                  .flatMap((l) => {
                    if (l.provider === 'ollama') {
                      return OLLAMA_FALLBACK_OPTIONS.map((m) => (
                        <option key={`${l.id}::${m}`} value={`${l.id}::${m}`}>
                          Ollama · {m}
                        </option>
                      ))
                    }
                    return [
                      <option key={l.id} value={l.id}>
                        {l.label} · {l.model}
                      </option>
                    ]
                  })}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
              降级 STT WebSocket
              <input
                type="text"
                className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 font-mono text-sm text-[var(--text)]"
                value={settings.engine.fallbackStt.websocketUrl}
                onChange={(e) =>
                  setEngine({
                    fallbackStt: {
                      ...settings.engine.fallbackStt,
                      websocketUrl: e.target.value
                    }
                  })
                }
              />
            </label>
            {fallbackLlm && settings.engine.fallbackLlmId !== LLM_NONE_ID ? (
              <p className="text-[10px] text-[var(--text-muted)]">
                本地默认：{fallbackLlm.baseUrl} ·{' '}
                {settings.engine.fallbackLlmModel || fallbackLlm.model}
              </p>
            ) : settings.engine.fallbackLlmId === LLM_NONE_ID ? (
              <p className="text-[10px] text-[var(--text-muted)]">
                云端失败时将关闭翻译，不加载本地大模型（保护显存）
              </p>
            ) : null}
          </section>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border)] px-4 py-3">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleDefault}
              className="rounded border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              默认
            </button>
            <button
              type="button"
              onClick={handleRestore}
              className="rounded border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text)] hover:border-[var(--accent)]"
            >
              恢复
            </button>
            <button
              type="button"
              onClick={handleSave}
              className={`rounded border px-3 py-1.5 text-sm font-medium transition ${
                persistHint === '已保存'
                  ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                  : 'border-[var(--border)] bg-[var(--accent-soft)] text-[var(--accent)]'
              }`}
            >
              {persistHint === '已保存' ? '已保存' : '保存'}
            </button>
            {persistHint && persistHint !== '已保存' ? (
              <span className="text-[10px] text-[var(--text-muted)]">{persistHint}</span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-[var(--accent-soft)] px-4 py-1.5 text-sm text-[var(--accent)]"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
