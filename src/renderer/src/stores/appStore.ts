import { create } from 'zustand'
import {
  DEFAULT_SETTINGS,
  derivePipelineMode,
  getActiveLlm,
  pipelineModeLabel,
  type AppSettings,
  type AudioSettings,
  type DisplaySettings,
  type EngineSettings,
  type LlmEndpointConfig,
  type PipelineModePreset,
  type SttConfig,
  type SubtitleDisplaySettings,
  type TermItem,
  type TerminologyItem,
  type TranscriptSegment,
  type TranslationDirection,
  type TranslationSegment,
  type WindowMode
} from '@shared/types'

interface AppState {
  settings: AppSettings
  transcripts: TranscriptSegment[]
  /** Live Paraformer partial (not yet final) */
  partialText: string
  translations: TranslationSegment[]
  terms: TerminologyItem[]
  /** LLM async term extract (CSV matcher always on; this only gates LLM) */
  isLlmExtractionEnabled: boolean
  isListening: boolean
  pipelineStatus: string
  /** STT WebSocket link while a listening session is active */
  sttLinkStatus: 'idle' | 'connected' | 'disconnected' | 'reconnecting'
  inputLevel: number
  vadSegmentCount: number
  /** True after user or auto degrade switched to local engines */
  degraded: boolean
  /** Single-window morph: full | subtitle (renderer view) */
  windowMode: WindowMode

  setDisplay: (partial: Partial<DisplaySettings>) => void
  setAudio: (partial: Partial<AudioSettings>) => void
  setStt: (partial: Partial<SttConfig>) => void
  setEngine: (partial: Partial<EngineSettings>) => void
  setSubtitleDisplay: (partial: Partial<SubtitleDisplaySettings>) => void
  updateLlm: (id: string, partial: Partial<LlmEndpointConfig>) => void
  setActiveLlm: (id: string) => void
  applyPipelinePreset: (preset: PipelineModePreset) => void
  degradeToOffline: () => void
  restoreCloudPreferred: () => void
  setSubtitleSplitRatio: (ratio: number) => void
  setTranslationDirection: (direction: TranslationDirection) => void
  setWindowMode: (mode: WindowMode) => void
  setListening: (v: boolean) => void
  setPipelineStatus: (s: string) => void
  setSttLinkStatus: (s: AppState['sttLinkStatus']) => void
  setInputLevel: (level: number) => void
  setPartialText: (text: string) => void
  bumpVadSegment: () => void
  upsertTranscript: (seg: TranscriptSegment) => void
  upsertTranslation: (seg: TranslationSegment) => void
  removeTranslation: (id: string) => void
  addTerm: (term: TermItem) => void
  toggleTermPin: (id: string) => void
  removeTerm: (id: string) => void
  /** CSV worker hits: pin + bump timestamp; dedupe by foreignText */
  upsertCsvMatchedTerms: (hits: { foreignText: string; chineseText: string }[]) => void
  /** LLM async extract: unpinned; skip if foreignText already present */
  mergeLlmExtractedTerms: (hits: { foreignText: string; chineseText: string }[]) => void
  setLlmExtractionEnabled: (enabled: boolean) => void
  seedDemoContent: () => void
  clearSession: () => void
  getPipelineMode: () => PipelineModePreset
  getPipelineModeLabel: () => string
}

export const useAppStore = create<AppState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  transcripts: [],
  partialText: '',
  translations: [],
  terms: [],
  isLlmExtractionEnabled: false,
  isListening: false,
  pipelineStatus: '待命 · 等待麦克风接入',
  sttLinkStatus: 'idle',
  inputLevel: 0,
  vadSegmentCount: 0,
  degraded: false,
  windowMode: 'full',

  setDisplay: (partial) =>
    set((s) => ({
      settings: { ...s.settings, display: { ...s.settings.display, ...partial } }
    })),

  setAudio: (partial) =>
    set((s) => ({
      settings: { ...s.settings, audio: { ...s.settings.audio, ...partial } }
    })),

  setStt: (partial) =>
    set((s) => ({
      settings: { ...s.settings, stt: { ...s.settings.stt, ...partial } }
    })),

  setEngine: (partial) =>
    set((s) => ({
      settings: { ...s.settings, engine: { ...s.settings.engine, ...partial } }
    })),

  setSubtitleDisplay: (partial) =>
    set((s) => {
      const cur = s.settings.subtitleDisplay ?? {
        displayMode: 'count' as const,
        countLimit: 2,
        timeLimit: 15
      }
      const next = { ...cur, ...partial }
      next.countLimit = Math.min(5, Math.max(1, next.countLimit))
      next.timeLimit = Math.min(45, Math.max(5, next.timeLimit))
      return {
        settings: { ...s.settings, subtitleDisplay: next }
      }
    }),

  updateLlm: (id, partial) =>
    set((s) => ({
      settings: {
        ...s.settings,
        llms: s.settings.llms.map((l) => (l.id === id ? { ...l, ...partial } : l))
      }
    })),

  setActiveLlm: (id) =>
    set((s) => ({
      settings: {
        ...s.settings,
        engine: { ...s.settings.engine, activeLlmId: id }
      },
      degraded: false
    })),

  applyPipelinePreset: (preset) =>
    set((s) => {
      const cloudStt: SttConfig = {
        provider: 'deepgram',
        websocketUrl: '',
        apiKey: s.settings.stt.apiKey,
        model: 'nova-2',
        language: s.settings.stt.language
      }
      const localStt = { ...s.settings.engine.fallbackStt }
      const cloudLlm =
        s.settings.llms.find((l) => l.provider === 'deepseek')?.id ??
        s.settings.llms.find((l) => l.tier === 'cloud')?.id ??
        'deepseek-v4-flash'
      const localLlm = s.settings.engine.fallbackLlmId

      let stt = s.settings.stt
      let activeLlmId = s.settings.engine.activeLlmId

      switch (preset) {
        case 'cloud':
          stt = { ...cloudStt, provider: 'deepgram' }
          activeLlmId = cloudLlm
          break
        case 'offline':
          stt = localStt
          activeLlmId = localLlm
          break
        case 'hybrid-cloud-stt':
          stt = { ...cloudStt, provider: 'deepgram' }
          activeLlmId = localLlm
          break
        case 'hybrid-local-stt':
          stt = localStt
          activeLlmId = cloudLlm
          break
      }

      return {
        settings: {
          ...s.settings,
          stt,
          engine: { ...s.settings.engine, activeLlmId }
        },
        degraded: preset === 'offline',
        pipelineStatus: `已切换至${pipelineModeLabel(preset)}模式`
      }
    }),

  degradeToOffline: () =>
    set((s) => {
      const fbId = s.settings.engine.fallbackLlmId
      const fbModel = s.settings.engine.fallbackLlmModel
      if (fbId === 'none' || !fbId) {
        return {
          settings: {
            ...s.settings,
            stt: { ...s.settings.engine.fallbackStt },
            engine: {
              ...s.settings.engine,
              activeLlmId: 'none'
            }
          },
          degraded: true,
          pipelineStatus: '云端失败 · 降级 LLM 为 N/A，已关闭目标语言翻译'
        }
      }
      let llms = s.settings.llms
      if (fbModel) {
        llms = llms.map((l) =>
          l.id === fbId ? { ...l, model: fbModel } : l
        )
      }
      return {
        settings: {
          ...s.settings,
          stt: { ...s.settings.engine.fallbackStt },
          llms,
          engine: {
            ...s.settings.engine,
            activeLlmId: fbId
          }
        },
        degraded: true,
        pipelineStatus: '已降级至全离线（本地 STT + Ollama/本地 LLM）'
      }
    }),

  restoreCloudPreferred: () =>
    set((s) => {
      const cloudLlm =
        s.settings.llms.find((l) => l.tier === 'cloud' && l.apiKey)?.id ??
        s.settings.llms.find((l) => l.tier === 'cloud')?.id ??
        s.settings.engine.activeLlmId
      return {
        settings: {
          ...s.settings,
          stt: {
            ...s.settings.stt,
            provider: 'deepgram'
          },
          engine: { ...s.settings.engine, activeLlmId: cloudLlm }
        },
        degraded: false,
        pipelineStatus: '已恢复云端优先配置（请确认 API Key / 网络）'
      }
    }),

  setSubtitleSplitRatio: (ratio) =>
    set((s) => ({
      settings: {
        ...s.settings,
        subtitleSplitRatio: Math.min(0.8, Math.max(0.2, ratio))
      }
    })),

  setTranslationDirection: (direction) =>
    set((s) => ({
      settings: { ...s.settings, translationDirection: direction },
      pipelineStatus:
        direction === 'zh-en'
          ? '主方向：中译英 · 检测到英文时 Auto-LID 自动反向'
          : '主方向：英译中 · 检测到中文时 Auto-LID 自动反向'
    })),

  setWindowMode: (mode) => set({ windowMode: mode }),

  setListening: (v) => set({ isListening: v }),
  setPipelineStatus: (pipelineStatus) => set({ pipelineStatus }),
  setSttLinkStatus: (sttLinkStatus) => set({ sttLinkStatus }),
  setInputLevel: (inputLevel) => set({ inputLevel }),
  setPartialText: (partialText) => set({ partialText }),
  bumpVadSegment: () => set((s) => ({ vadSegmentCount: s.vadSegmentCount + 1 })),

  upsertTranscript: (seg) =>
    set((s) => {
      const idx = s.transcripts.findIndex((t) => t.id === seg.id)
      if (idx === -1) return { transcripts: [...s.transcripts, seg] }
      const next = [...s.transcripts]
      next[idx] = seg
      return { transcripts: next }
    }),

  upsertTranslation: (seg) =>
    set((s) => {
      const idx = s.translations.findIndex((t) => t.id === seg.id)
      if (idx === -1) return { translations: [...s.translations, seg] }
      const next = [...s.translations]
      next[idx] = seg
      return { translations: next }
    }),

  removeTranslation: (id) =>
    set((s) => ({
      translations: s.translations.filter((t) => t.id !== id)
    })),

  addTerm: (term) =>
    set((s) => {
      if (
        s.terms.some(
          (t) => t.foreignText === term.foreignText && t.chineseText === term.chineseText
        )
      ) {
        return s
      }
      return {
        terms: [{ ...term, isPinned: Boolean(term.isPinned) }, ...s.terms].slice(0, 100)
      }
    }),

  toggleTermPin: (id) =>
    set((s) => ({
      terms: s.terms.map((t) => (t.id === id ? { ...t, isPinned: !t.isPinned } : t))
    })),

  removeTerm: (id) =>
    set((s) => ({
      terms: s.terms.filter((t) => t.id !== id)
    })),

  upsertCsvMatchedTerms: (hits) =>
    set((s) => {
      if (!hits.length) return s
      const now = Date.now()
      let terms = [...s.terms]
      for (const hit of hits) {
        const foreign = hit.foreignText.trim()
        const chinese = hit.chineseText.trim()
        if (!foreign || !chinese) continue
        const idx = terms.findIndex(
          (t) => t.foreignText.toLowerCase() === foreign.toLowerCase()
        )
        if (idx >= 0) {
          const prev = terms[idx]
          terms[idx] = {
            ...prev,
            chineseText: chinese || prev.chineseText,
            isPinned: true,
            timestamp: now
          }
        } else {
          terms = [
            {
              id: `csv-${now}-${Math.random().toString(36).slice(2, 7)}`,
              foreignText: foreign,
              chineseText: chinese,
              isPinned: true,
              timestamp: now
            },
            ...terms
          ]
        }
      }
      return { terms: terms.slice(0, 100) }
    }),

  mergeLlmExtractedTerms: (hits) =>
    set((s) => {
      if (!hits.length) return s
      const now = Date.now()
      let terms = [...s.terms]
      let changed = false
      for (const hit of hits) {
        const foreign = hit.foreignText.trim()
        const chinese = hit.chineseText.trim()
        if (!foreign || !chinese) continue
        const exists = terms.some(
          (t) => t.foreignText.toLowerCase() === foreign.toLowerCase()
        )
        if (exists) continue
        changed = true
        terms = [
          {
            id: `llm-${now}-${Math.random().toString(36).slice(2, 7)}`,
            foreignText: foreign,
            chineseText: chinese,
            isPinned: false,
            timestamp: now
          },
          ...terms
        ]
      }
      return changed ? { terms: terms.slice(0, 100) } : s
    }),

  setLlmExtractionEnabled: (enabled) => set({ isLlmExtractionEnabled: enabled }),

  seedDemoContent: () =>
    set({
      transcripts: [
        {
          id: 't1',
          text: "Ladies and gentlemen, welcome to today's briefing on renewable energy policy.",
          isFinal: true,
          timestamp: Date.now() - 8000,
          lang: 'en'
        },
        {
          id: 't2',
          text: '我们将概述碳中和路线图，并讨论电网灵活性措施。',
          isFinal: true,
          timestamp: Date.now() - 5000,
          lang: 'zh'
        },
        {
          id: 't3',
          text: 'Please note that pumped storage and demand response remain key enablers…',
          isFinal: false,
          timestamp: Date.now(),
          lang: 'en'
        }
      ],
      translations: [
        {
          id: 'tr1',
          sourceId: 't1',
          text: '各位来宾，欢迎参加今天关于可再生能源政策的简报会。',
          streaming: false,
          timestamp: Date.now() - 7500,
          lang: 'en',
          direction: 'en-zh'
        },
        {
          id: 'tr2',
          sourceId: 't2',
          text: 'We will outline the carbon neutrality roadmap and discuss grid flexibility measures.',
          streaming: false,
          timestamp: Date.now() - 4500,
          lang: 'zh',
          direction: 'zh-en'
        },
        {
          id: 'tr3',
          sourceId: 't3',
          text: '请注意，抽水蓄能与需求响应仍是关键支撑手段…',
          streaming: true,
          timestamp: Date.now(),
          lang: 'en',
          direction: 'en-zh'
        }
      ],
      terms: [
        {
          id: 'term1',
          foreignText: 'carbon neutrality',
          chineseText: '碳中和',
          isPinned: false,
          timestamp: Date.now() - 2000
        },
        {
          id: 'term2',
          foreignText: 'pumped storage',
          chineseText: '抽水蓄能',
          isPinned: true,
          timestamp: Date.now() - 1000
        },
        {
          id: 'term3',
          foreignText: 'demand response',
          chineseText: '需求响应',
          isPinned: false,
          timestamp: Date.now()
        },
        {
          id: 'term4',
          foreignText: 'grid flexibility',
          chineseText: '电网灵活性',
          isPinned: false,
          timestamp: Date.now() - 500
        },
        {
          id: 'term5',
          foreignText: 'renewable energy',
          chineseText: '可再生能源',
          isPinned: false,
          timestamp: Date.now() - 300
        },
        {
          id: 'term6',
          foreignText: 'briefing',
          chineseText: '简报会',
          isPinned: false,
          timestamp: Date.now() - 100
        }
      ],
      pipelineStatus: '演示数据 · 含 Auto-LID [EN]/[ZH] 标签与主副方向示例'
    }),

  clearSession: () =>
    set({
      transcripts: [],
      partialText: '',
      translations: [],
      terms: [],
      vadSegmentCount: 0,
      pipelineStatus: '会话已清空'
    }),

  getPipelineMode: () => {
    const s = get().settings
    return derivePipelineMode(s.stt, getActiveLlm(s))
  },

  getPipelineModeLabel: () => pipelineModeLabel(get().getPipelineMode())
}))
