import { useEffect, useRef, useState } from 'react'
import {
  defaultSttModel,
  defaultSttWebsocketUrl,
  getActiveLlm,
  localSttLauncherKey,
  type SttProviderKind
} from '@shared/types'
import { fetchOllamaModels, pickPreferredOllamaModel } from '../services/llm'
import { useAppStore } from '../stores/appStore'
import { useClickOutside } from '../hooks/useClickOutside'

const STT_PROVIDERS: Array<{ value: SttProviderKind; label: string; tier: 'cloud' | 'local' }> =
  [
    { value: 'local-sensevoice', label: '本地 SenseVoice（稳定/抗噪）', tier: 'local' },
    { value: 'local-paraformer', label: '本地 Paraformer（极速流式）', tier: 'local' },
    { value: 'faster-whisper-medium', label: 'Faster-Whisper (Medium)', tier: 'local' },
    { value: 'faster-whisper-large-v3', label: 'Faster-Whisper (Large-v3)', tier: 'local' },
    { value: 'deepgram', label: 'Deepgram', tier: 'cloud' },
    { value: 'azure', label: 'Azure Speech', tier: 'cloud' },
    { value: 'aliyun', label: '阿里云', tier: 'cloud' }
  ]

const OLLAMA_FALLBACK_MODELS = ['qwen2.5:7b', 'qwen2.5:14b']

/**
 * Header click popover for quick STT + LLM switching.
 * Click outside closes (same pattern as HeaderDisplaySettings).
 * LLM/model changes go through the store so useAudioPipeline aborts in-flight translate.
 */
export function HeaderEngineSettings(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const setStt = useAppStore((s) => s.setStt)
  const setActiveLlm = useAppStore((s) => s.setActiveLlm)
  const updateLlm = useAppStore((s) => s.updateLlm)

  const activeLlm = getActiveLlm(settings)
  const isOllama = activeLlm?.provider === 'ollama'
  const selectedModel = activeLlm?.model ?? ''

  const [open, setOpen] = useState(false)
  const [availableModels, setAvailableModels] = useState<string[]>([
    ...OLLAMA_FALLBACK_MODELS
  ])
  const [modelsLoading, setModelsLoading] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Local engine process control (spawned engines only; cloud STT hides this)
  const launcherKey = localSttLauncherKey(settings.stt.provider)
  const [engineRunning, setEngineRunning] = useState<boolean | null>(null)
  const [engineBusy, setEngineBusy] = useState(false)
  const [engineError, setEngineError] = useState<string | null>(null)

  useClickOutside(rootRef, open, () => setOpen(false))

  useEffect(() => {
    if (!open || !launcherKey) return
    let alive = true
    const probe = (): void => {
      void window.whisperApi
        ?.getSttEngineStatus?.(launcherKey)
        .then((r) => {
          if (alive) setEngineRunning(Boolean(r?.running))
        })
        .catch(() => {
          if (alive) setEngineRunning(null)
        })
    }
    probe()
    const timer = window.setInterval(probe, 2000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [open, launcherKey])

  const startEngine = async (): Promise<void> => {
    if (!launcherKey || engineBusy) return
    setEngineBusy(true)
    setEngineError(null)
    try {
      const r = await window.whisperApi?.ensureSttEngine?.(launcherKey, 60000)
      if (r && !r.ok) {
        setEngineError(r.error ?? '启动失败（详见 logs/stt_launcher.log）')
      }
    } catch (e) {
      setEngineError(e instanceof Error ? e.message : String(e))
    } finally {
      setEngineBusy(false)
    }
  }

  const stopEngine = async (): Promise<void> => {
    if (engineBusy) return
    setEngineBusy(true)
    try {
      await window.whisperApi?.stopSttEngines?.()
    } finally {
      setEngineBusy(false)
    }
  }

  useEffect(() => {
    if (!open || !activeLlm || activeLlm.provider !== 'ollama') return

    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 4000)
    setModelsLoading(true)

    void (async () => {
      try {
        const names = await fetchOllamaModels(activeLlm.baseUrl, controller.signal)
        if (controller.signal.aborted) return
        const merged = [
          ...names,
          ...OLLAMA_FALLBACK_MODELS.filter((n) => !names.includes(n))
        ]
        setAvailableModels(merged)
        const preferred = pickPreferredOllamaModel(merged, activeLlm.model)
        if (
          preferred &&
          preferred !== activeLlm.model &&
          (!activeLlm.model || !merged.includes(activeLlm.model))
        ) {
          updateLlm(activeLlm.id, { model: preferred })
        }
      } catch {
        setAvailableModels((prev) =>
          prev.length > 0 ? prev : [...OLLAMA_FALLBACK_MODELS]
        )
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
    updateLlm
  ])

  const selectSttProvider = (provider: SttProviderKind): void => {
    const url = defaultSttWebsocketUrl(provider)
    setStt({
      provider,
      ...(url ? { websocketUrl: url } : {}),
      model: defaultSttModel(provider) || settings.stt.model
    })
  }

  const modelOptions = [
    ...new Set([
      ...availableModels,
      ...OLLAMA_FALLBACK_MODELS,
      ...(selectedModel ? [selectedModel] : [])
    ])
  ]

  /** Encode LLM choice so one <select> covers endpoints + Ollama models. */
  const llmSelectValue = isOllama
    ? `model:${selectedModel}`
    : `llm:${settings.engine.activeLlmId}`

  const handleLlmChange = (raw: string): void => {
    if (raw.startsWith('model:')) {
      const model = raw.slice('model:'.length)
      const ollama = settings.llms.find((l) => l.provider === 'ollama')
      if (!ollama) return
      // Store updates trigger useAudioPipeline abort + re-queue
      if (settings.engine.activeLlmId !== ollama.id) {
        setActiveLlm(ollama.id)
      }
      if (ollama.model !== model) {
        updateLlm(ollama.id, { model })
      }
      return
    }
    if (raw.startsWith('llm:')) {
      setActiveLlm(raw.slice('llm:'.length))
    }
  }

  return (
    <div
      ref={rootRef}
      className="settings-wrapper relative"
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      <button
        type="button"
        aria-label="引擎设置"
        aria-expanded={open}
        title="引擎设置（STT / LLM）"
        className="flex h-8 w-8 items-center justify-center rounded border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)]"
        style={{ WebkitAppRegion: 'no-drag' }}
        onClick={() => setOpen((v) => !v)}
      >
        <CpuIcon />
      </button>

      {open && (
        <div
          className="settings-panel absolute right-0 z-50 w-64 rounded border border-[var(--border)] bg-[var(--bg-panel)] p-3 shadow-xl"
          style={{
            WebkitAppRegion: 'no-drag',
            top: '100%'
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
            引擎设置
          </p>

          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-[10px] text-[var(--text-muted)]">
              STT引擎
              <select
                className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-[11px] text-[var(--text)]"
                value={
                  settings.stt.provider === 'local-faster-whisper' ||
                  settings.stt.provider === 'faster-whisper'
                    ? 'faster-whisper-medium'
                    : settings.stt.provider
                }
                onChange={(e) =>
                  selectSttProvider(e.target.value as SttProviderKind)
                }
              >
                {STT_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    [{p.tier === 'cloud' ? '云' : '本地'}] {p.label}
                  </option>
                ))}
              </select>
            </label>

            {launcherKey && (
              <div className="flex flex-col gap-1.5 rounded border border-[var(--border)] px-2.5 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-[var(--text-muted)]">引擎进程</span>
                  <span
                    className={`inline-flex items-center gap-1 text-[10px] ${
                      engineRunning ? 'text-emerald-400' : 'text-[var(--text-muted)]'
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        engineRunning ? 'bg-emerald-400' : 'bg-slate-500'
                      }`}
                    />
                    {engineBusy
                      ? '处理中…'
                      : engineRunning
                        ? '运行中'
                        : engineRunning === null
                          ? '检测中'
                          : '未启动'}
                  </span>
                </div>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    disabled={engineRunning === true || engineBusy}
                    onClick={() => void startEngine()}
                    className="flex-1 rounded bg-[var(--accent-soft)] px-2 py-1.5 text-[11px] font-medium text-[var(--accent)] transition hover:bg-[var(--accent)]/25 disabled:cursor-not-allowed disabled:opacity-40"
                    title="在后台拉起引擎并等待模型就绪（10–40 秒）"
                  >
                    启动引擎
                  </button>
                  <button
                    type="button"
                    disabled={!engineRunning || engineBusy}
                    onClick={() => void stopEngine()}
                    className="flex-1 rounded border border-[var(--border)] px-2 py-1.5 text-[11px] text-[var(--text-muted)] transition hover:border-[var(--danger)] hover:text-[var(--danger)] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    停止
                  </button>
                  <button
                    type="button"
                    onClick={() => void window.whisperApi?.openSessionLogsDir?.()}
                    className="rounded border border-[var(--border)] px-2 py-1.5 text-[11px] text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)]"
                    title="打开日志目录：引擎运行详情在 stt_launcher.log（带时间戳，逐行记录）"
                  >
                    日志
                  </button>
                </div>
                {engineError && (
                  <p className="text-[10px] leading-snug text-[var(--danger)]">
                    ❌ 启动失败：{engineError}
                  </p>
                )}
                <p className="text-[10px] leading-snug text-[var(--text-muted)]/70">
                  引擎输出逐行记入 logs/stt_launcher.log（含识别结果与异常）；
                  「开始听写」时也会自动拉起；停止仅作用于由本应用启动的引擎，
                  6GB 显存只够一个引擎驻留，切换引擎自动互斥。
                </p>
              </div>
            )}

            <label className="flex flex-col gap-1 text-[10px] text-[var(--text-muted)]">
              LLM
              <select
                className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-[11px] text-[var(--text)]"
                value={
                  settings.engine.activeLlmId === 'none'
                    ? 'none'
                    : llmSelectValue
                }
                onChange={(e) => {
                  if (e.target.value === 'none') {
                    setActiveLlm('none')
                    return
                  }
                  handleLlmChange(e.target.value)
                }}
              >
                <option value="none">N/A (不启用)</option>
                {settings.llms.flatMap((l) => {
                  if (l.provider === 'ollama') {
                    return modelOptions.map((name) => (
                      <option key={`ollama-${name}`} value={`model:${name}`}>
                        [本地] {name}
                      </option>
                    ))
                  }
                  return [
                    <option key={l.id} value={`llm:${l.id}`}>
                      [{l.tier === 'cloud' ? '云' : '本地'}] {l.label} · {l.model}
                    </option>
                  ]
                })}
              </select>
            </label>

            {isOllama && modelsLoading ? (
              <p className="text-[10px] text-[var(--text-muted)]/80">正在拉取 Ollama 模型…</p>
            ) : (
              <p className="text-[10px] leading-snug text-[var(--text-muted)]/80">
                切换 LLM / 模型会立即中断当前翻译并无缝接管
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function CpuIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
    </svg>
  )
}
