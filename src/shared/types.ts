/** Shared types for main ↔ renderer ↔ STT/LLM dual-engine pipeline */

export type WindowMode = 'full' | 'subtitle'

export type EngineTier = 'cloud' | 'local'

/** User-facing pipeline presets (STT × LLM combinations) */
export type PipelineModePreset =
  | 'cloud'
  | 'offline'
  | 'hybrid-cloud-stt'
  | 'hybrid-local-stt'

export type SttProviderKind =
  | 'deepgram'
  | 'azure'
  | 'aliyun'
  | 'local-sensevoice'
  | 'local-paraformer'
  | 'local-faster-whisper'
  | 'faster-whisper'
  | 'faster-whisper-medium'
  | 'faster-whisper-large-v3'

export type FasterWhisperModelSize = 'medium' | 'large-v3'

export type LlmProviderKind = 'gemini' | 'deepseek' | 'ollama' | 'openai-compatible'

/** Hard translation direction for small local models (e.g. Qwen 7B) */
export type TranslationDirection = 'en-zh' | 'zh-en'


export interface DisplaySettings {
  /** CJK font stack (content panels only) */
  chineseFont: string
  /** Latin font stack (content panels only; listed before chineseFont) */
  westernFont: string
  fontSize: number
  zoomScale: number
  /** Content text line-height multiplier (source / target / terms) */
  lineHeight: number
}

/** Floating subtitle overlay display strategy */
export type SubtitleDisplayMode = 'count' | 'time'

export interface SubtitleDisplaySettings {
  displayMode: SubtitleDisplayMode
  /** Keep latest N pairs (2–5) when displayMode === 'count' */
  countLimit: number
  /** Keep pairs within last N seconds (5–45) when displayMode === 'time' */
  timeLimit: number
  /** Unified font size for source + target (px) */
  fontSize?: number
  /** Window background opacity 0–100 */
  backgroundOpacity?: number
}

/** Joined STT + translation row for subtitle timeline */
export interface DialoguePair {
  id: string
  sttText: string
  translatedText: string
  lang?: 'zh' | 'en' | 'unknown'
  timestamp: number
}

/** Sync-recording export format (temp WAV → ffmpeg). */
export type RecordingFormatId = 'wav' | 'mp3-192k' | 'mp3-320k' | 'flac'

/** Labels shown in UI / config.json */
export type RecordingFormatLabel = '.wav' | '.mp3 320k' | '.flac'

export const RECORDING_FORMAT_OPTIONS: Array<{
  value: RecordingFormatId
  label: RecordingFormatLabel
}> = [
  { value: 'wav', label: '.wav' },
  { value: 'mp3-320k', label: '.mp3 320k' },
  { value: 'flac', label: '.flac' }
]

export function recordingFormatLabelToId(
  label: string
): RecordingFormatId {
  if (label === '.mp3 320k' || label === 'mp3-320k') return 'mp3-320k'
  if (label === '.flac' || label === 'flac') return 'flac'
  return 'wav'
}

export function recordingFormatIdToLabel(
  id: RecordingFormatId
): RecordingFormatLabel {
  if (id === 'mp3-320k' || id === 'mp3-192k') return '.mp3 320k'
  if (id === 'flac') return '.flac'
  return '.wav'
}

export interface AudioSettings {
  volume: number
  gain: number
  sampleRate: 16000
  maxSentenceMs: number
  /** Silence hold that ends a sentence (VAD redemption / stream settle) */
  vadSilenceMs: number
  /** empty = system default mic */
  deviceId: string
  /** Capture PCM while STT is listening (default on) */
  syncRecording: boolean
  recordingFormat: RecordingFormatId
  /** Absolute or project-relative path; default "recordings" */
  recordingDir: string
}

/** Bounds for the sentence-break silence slider */
export const VAD_SILENCE_MIN_MS = 300
export const VAD_SILENCE_MAX_MS = 2000
export const VAD_SILENCE_STEP_MS = 50

export function clampVadSilenceMs(ms: number): number {
  if (!Number.isFinite(ms)) return 800
  return Math.min(VAD_SILENCE_MAX_MS, Math.max(VAD_SILENCE_MIN_MS, Math.round(ms / VAD_SILENCE_STEP_MS) * VAD_SILENCE_STEP_MS))
}

/** Local engine keys understood by the main-process STT launcher */
export type LocalSttEngineKey = 'local-sensevoice' | 'local-paraformer' | 'faster-whisper'

/** Map a STT provider to its backend process (null = cloud / not launchable) */
export function localSttLauncherKey(provider: SttProviderKind): LocalSttEngineKey | null {
  if (provider === 'local-sensevoice') return 'local-sensevoice'
  if (provider === 'local-paraformer') return 'local-paraformer'
  if (isFasterWhisperStt(provider)) return 'faster-whisper'
  return null
}

export interface SttConfig {
  provider: SttProviderKind
  websocketUrl: string
  apiKey: string
  /** e.g. nova-2 / whisper-large-v3 */
  model: string
  /** empty = auto / server default */
  language: string
}

/** Unified LLM endpoint — cloud or local OpenAI-compatible */
export interface LlmEndpointConfig {
  id: string
  label: string
  provider: LlmProviderKind
  tier: EngineTier
  apiKey: string
  baseUrl: string
  model: string
  systemPrompt: string
}

export interface EngineSettings {
  /** Currently selected LLM endpoint id — use `none` to disable translation */
  activeLlmId: string
  /** Local STT used when degrading from cloud */
  fallbackStt: SttConfig
  /** Local LLM id when degrading — `none` = disable translation instead */
  fallbackLlmId: string
  /** Optional model tag when fallback LLM is Ollama (e.g. qwen2.5:7b) */
  fallbackLlmModel?: string
  /** Auto-switch to fallback when cloud unreachable */
  autoDegrade: boolean
}

export interface AppSettings {
  display: DisplaySettings
  audio: AudioSettings
  stt: SttConfig
  llms: LlmEndpointConfig[]
  engine: EngineSettings
  subtitleSplitRatio: number
  /** EN↔ZH direction for LLM translation prompts */
  translationDirection: TranslationDirection
  /** Floating subtitle: count vs time window */
  subtitleDisplay: SubtitleDisplaySettings
}

export const DEFAULT_SYSTEM_PROMPT =
  '你是一名专业同声传译助手。将用户给出的源语言文本准确、流畅地翻译为目标语言。默认支持中英双向：若输入为中文则译为英文，若输入为英文则译为中文。保持术语一致，不要添加解释。'

export const TERM_EXTRACT_PROMPT = `任务：从以下对话中提取出专业属性的实体名词、专有名词或行业术语。
严格限制：
1. 不要提取日常用语。
2. 只输出一个合法的 JSON 数组，绝对不要输出任何 markdown 标记（如 \`\`\`json）、前言或解释。
3. 格式必须为：[{"foreignText": "英文原文", "chineseText": "中文翻译"}]。如果没有提取到，输出 []。`

export const CLOUD_STT_PROVIDERS: SttProviderKind[] = ['deepgram', 'azure', 'aliyun']
export const LOCAL_STT_PROVIDERS: SttProviderKind[] = [
  'local-sensevoice',
  'local-paraformer',
  'local-faster-whisper',
  'faster-whisper',
  'faster-whisper-medium',
  'faster-whisper-large-v3'
]

/** SenseVoice / Faster-Whisper: whole-utterance PCM via Silero VAD flush */
export function isUtteranceLocalStt(provider: SttProviderKind): boolean {
  return (
    provider === 'local-sensevoice' ||
    isFasterWhisperStt(provider)
  )
}

/** Faster-Whisper family (shared ws://127.0.0.1:8767) */
export function isFasterWhisperStt(provider: SttProviderKind): boolean {
  return (
    provider === 'faster-whisper' ||
    provider === 'local-faster-whisper' ||
    provider === 'faster-whisper-medium' ||
    provider === 'faster-whisper-large-v3'
  )
}

/** Map provider → backend hot-swap model id */
export function fasterWhisperModelSize(
  provider: SttProviderKind
): FasterWhisperModelSize | null {
  switch (provider) {
    case 'faster-whisper-large-v3':
      return 'large-v3'
    case 'faster-whisper-medium':
    case 'faster-whisper':
    case 'local-faster-whisper':
      return 'medium'
    default:
      return null
  }
}

/** Paraformer: true streaming partial/final + is_final */
export function isParaformerStt(provider: SttProviderKind): boolean {
  return provider === 'local-paraformer'
}

export function defaultSttWebsocketUrl(provider: SttProviderKind): string {
  switch (provider) {
    case 'local-paraformer':
      return 'ws://127.0.0.1:8766'
    case 'local-sensevoice':
      return 'ws://127.0.0.1:8765'
    case 'faster-whisper':
    case 'local-faster-whisper':
    case 'faster-whisper-medium':
    case 'faster-whisper-large-v3':
      return 'ws://127.0.0.1:8767'
    default:
      return ''
  }
}

/** Prefer 127.0.0.1 over localhost (Windows IPv6 ::1 mismatch). */
export function normalizeLocalWsUrl(url: string): string {
  return url.replace(/\/\/localhost(?=[:/]|$)/gi, '//127.0.0.1')
}

export function defaultSttModel(provider: SttProviderKind): string {
  switch (provider) {
    case 'local-paraformer':
      return 'Paraformer-streaming'
    case 'local-sensevoice':
      return 'SenseVoiceSmall'
    case 'faster-whisper-large-v3':
      return 'faster-whisper-large-v3'
    case 'faster-whisper-medium':
    case 'faster-whisper':
    case 'local-faster-whisper':
      return 'faster-whisper-medium'
    case 'deepgram':
      return 'nova-2'
    default:
      return ''
  }
}

export function isCloudStt(provider: SttProviderKind): boolean {
  return CLOUD_STT_PROVIDERS.includes(provider)
}

/** Sentinel: translation / fallback disabled */
export const LLM_NONE_ID = 'none'

export function getActiveLlm(
  settings: AppSettings
): LlmEndpointConfig | undefined {
  const id = settings.engine.activeLlmId
  if (!id || id === LLM_NONE_ID) return undefined
  return settings.llms.find((l) => l.id === id)
}

export function derivePipelineMode(
  stt: SttConfig,
  llm: LlmEndpointConfig | undefined
): PipelineModePreset {
  const sttCloud = isCloudStt(stt.provider)
  const llmCloud = llm?.tier === 'cloud'
  if (sttCloud && llmCloud) return 'cloud'
  if (!sttCloud && !llmCloud) return 'offline'
  if (sttCloud && !llmCloud) return 'hybrid-cloud-stt'
  return 'hybrid-local-stt'
}

export function pipelineModeLabel(mode: PipelineModePreset): string {
  switch (mode) {
    case 'cloud':
      return '全在线'
    case 'offline':
      return '全离线'
    case 'hybrid-cloud-stt':
      return '混合·在线STT'
    case 'hybrid-local-stt':
      return '混合·本地STT'
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  display: {
    chineseFont: '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif',
    westernFont:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial',
    fontSize: 16,
    zoomScale: 1,
    lineHeight: 1
  },
  audio: {
    volume: 1,
    gain: 1,
    sampleRate: 16000,
    maxSentenceMs: 15000,
    vadSilenceMs: 800,
    deviceId: '',
    syncRecording: true,
    recordingFormat: 'wav',
    recordingDir: 'recordings'
  },
  stt: {
    provider: 'local-sensevoice',
    websocketUrl: 'ws://127.0.0.1:8765',
    apiKey: '',
    model: 'SenseVoiceSmall',
    language: ''
  },
  llms: [
    {
      id: 'gemini',
      label: 'Gemini Flash',
      provider: 'gemini',
      tier: 'cloud',
      apiKey: '',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-2.0-flash',
      systemPrompt: DEFAULT_SYSTEM_PROMPT
    },
    {
      id: 'deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      provider: 'deepseek',
      tier: 'cloud',
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      systemPrompt: DEFAULT_SYSTEM_PROMPT
    },
    {
      id: 'deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      provider: 'deepseek',
      tier: 'cloud',
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      systemPrompt: DEFAULT_SYSTEM_PROMPT
    },
    {
      id: 'ollama-qwen',
      label: 'Ollama · Qwen2.5',
      provider: 'ollama',
      tier: 'local',
      apiKey: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:7b',
      systemPrompt: DEFAULT_SYSTEM_PROMPT
    },
    {
      id: 'openai-compat',
      label: 'OpenAI Compatible',
      provider: 'openai-compatible',
      tier: 'local',
      apiKey: '',
      baseUrl: 'http://localhost:1234/v1',
      model: 'local-model',
      systemPrompt: DEFAULT_SYSTEM_PROMPT
    }
  ],
  engine: {
    activeLlmId: 'ollama-qwen',
    fallbackStt: {
      provider: 'local-sensevoice',
      websocketUrl: 'ws://127.0.0.1:8765',
      apiKey: '',
      model: 'SenseVoiceSmall',
      language: ''
    },
    fallbackLlmId: 'ollama-qwen',
    fallbackLlmModel: 'qwen2.5:7b',
    autoDegrade: true
  },
  subtitleSplitRatio: 0.45,
  translationDirection: 'en-zh',
  subtitleDisplay: {
    displayMode: 'count',
    countLimit: 5,
    timeLimit: 15
  }
}

export interface TranscriptSegment {
  id: string
  text: string
  isFinal: boolean
  timestamp: number
  /** Auto-LID result for this utterance */
  lang?: 'zh' | 'en' | 'unknown'
}

export interface TranslationSegment {
  id: string
  sourceId: string
  text: string
  streaming: boolean
  timestamp: number
  /** Source utterance Auto-LID (same as linked transcript) */
  lang?: 'zh' | 'en' | 'unknown'
  /** Actual translate direction used (may reverse from main mode) */
  direction?: TranslationDirection
  /** system = model-switch / status divider in the target pane */
  type?: 'translation' | 'system'
}

export interface TermItem {
  id: string
  /** Foreign / non-Chinese form (EN, FR, etc.) */
  foreignText: string
  /** Chinese gloss */
  chineseText: string
  isPinned: boolean
  timestamp: number
}

/** @deprecated Use TermItem */
export type TerminologyItem = TermItem

/** Pipeline stages matching the architecture diagram */
export type PipelineStage =
  | 'mic-capture'
  | 'web-audio'
  | 'silero-vad'
  | 'pcm-packet'
  | 'stt-websocket'
  | 'context-buffer'
  | 'llm-translate'
  | 'term-extract'
