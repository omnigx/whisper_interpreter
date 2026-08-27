import type {
  SubtitleDisplaySettings,
  TranscriptSegment,
  TranslationSegment
} from './types'

/** Snapshot mirrored from main window → subtitle satellite (display only). */
export interface SubtitleMirrorState {
  partialText: string
  transcripts: TranscriptSegment[]
  translations: TranslationSegment[]
  subtitleDisplay: SubtitleDisplaySettings
  isListening: boolean
  pipelineStatus?: string
  /** Synced from main display settings (content fonts only). */
  chineseFont: string
  westernFont: string
}

export const DEFAULT_CHINESE_FONT =
  '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif'

export const DEFAULT_WESTERN_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial'

/** @deprecated use DEFAULT_CHINESE_FONT */
export const DEFAULT_MIRROR_CHINESE_FONT = DEFAULT_CHINESE_FONT
/** @deprecated use DEFAULT_WESTERN_FONT */
export const DEFAULT_MIRROR_WESTERN_FONT = DEFAULT_WESTERN_FONT
