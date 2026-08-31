import {
  DEFAULT_SETTINGS,
  recordingFormatLabelToId,
  type AppSettings,
  type EngineSettings,
  type LlmEndpointConfig,
  type SttConfig,
  type TranslationDirection
} from '@shared/types'
import { useAppStore } from '../stores/appStore'
import { hydrateApiKeysFromSecureStore } from './secureApiKeys'

const ENGINE_SAVE_KEY = 'whisper-engine-snapshot-v1'

export type EngineSnapshot = {
  stt: SttConfig
  engine: EngineSettings
  /** API keys stripped — restored from safeStorage */
  llms: LlmEndpointConfig[]
  translationDirection: TranslationDirection
}

function stripSecrets(llms: LlmEndpointConfig[]): LlmEndpointConfig[] {
  return llms.map((l) => ({
    ...l,
    apiKey: l.provider === 'ollama' ? l.apiKey || 'ollama' : ''
  }))
}

export function captureEngineSnapshot(settings: AppSettings): EngineSnapshot {
  return {
    stt: structuredClone(settings.stt),
    engine: structuredClone(settings.engine),
    llms: stripSecrets(settings.llms),
    translationDirection: settings.translationDirection ?? 'en-zh'
  }
}

export function persistEngineSnapshot(snapshot: EngineSnapshot): boolean {
  try {
    localStorage.setItem(ENGINE_SAVE_KEY, JSON.stringify(snapshot))
    return true
  } catch {
    return false
  }
}

export function loadEngineSnapshot(): EngineSnapshot | null {
  try {
    const raw = localStorage.getItem(ENGINE_SAVE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as EngineSnapshot
    if (!parsed?.stt || !parsed?.engine || !Array.isArray(parsed.llms)) return null
    return parsed
  } catch {
    return null
  }
}

export function applyEngineSnapshot(snapshot: EngineSnapshot): void {
  useAppStore.setState((s) => ({
    settings: {
      ...s.settings,
      stt: snapshot.stt,
      engine: {
        ...snapshot.engine,
        fallbackLlmModel:
          snapshot.engine.fallbackLlmModel ?? s.settings.engine.fallbackLlmModel
      },
      llms: snapshot.llms.map((l) => {
        const prev = s.settings.llms.find((x) => x.id === l.id)
        // Keep in-memory / vault keys when restoring stripped snapshot
        return {
          ...l,
          apiKey:
            l.provider === 'ollama'
              ? l.apiKey || 'ollama'
              : prev?.apiKey?.trim()
                ? prev.apiKey
                : ''
        }
      }),
      translationDirection: snapshot.translationDirection ?? 'en-zh'
    },
    degraded: false,
    pipelineStatus: '已恢复本地保存的引擎配置'
  }))
}

export function saveCurrentEngineConfig(): boolean {
  const snap = captureEngineSnapshot(useAppStore.getState().settings)
  return persistEngineSnapshot(snap)
}

export function restoreEngineConfig(): boolean {
  const snap = loadEngineSnapshot()
  if (!snap) return false
  applyEngineSnapshot(snap)
  return true
}

/** Hard reset to factory defaults (SenseVoice + Ollama qwen2.5:7b). */
export function resetEngineToDefaults(): void {
  const d = DEFAULT_SETTINGS
  useAppStore.setState((s) => ({
    settings: {
      ...s.settings,
      stt: structuredClone(d.stt),
      engine: structuredClone(d.engine),
      llms: stripSecrets(structuredClone(d.llms)).map((l) => {
        if (l.id === 'ollama-qwen') {
          return { ...l, model: 'qwen2.5:7b', apiKey: 'ollama' }
        }
        return l
      }),
      translationDirection: d.translationDirection
    },
    degraded: false,
    pipelineStatus: '已恢复出厂引擎默认（SenseVoice + Qwen2.5:7b）'
  }))
}

/** Apply recording_dir / recording_format from project-root config.json */
export async function bootRecordingConfig(): Promise<void> {
  try {
    const cfg = await window.whisperApi?.getAppConfig?.()
    if (!cfg) return
    useAppStore.getState().setAudio({
      recordingDir: cfg.recording_dir || 'recordings',
      recordingFormat: recordingFormatLabelToId(cfg.recording_format || '.wav')
    })
  } catch {
    /* keep defaults */
  }
}

/** Boot: restore last save, then hydrate encrypted API keys. */
export async function bootEngineConfig(): Promise<void> {
  restoreEngineConfig()
  await hydrateApiKeysFromSecureStore()
  await bootRecordingConfig()
}
