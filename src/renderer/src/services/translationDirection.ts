import type { TranslationDirection } from '@shared/types'
import {
  detectLanguage,
  type DetectedLanguage
} from '../utils/detectLanguage'

export type { DetectedLanguage }
export { detectLanguage }

export const EN_TO_ZH_SYSTEM_PROMPT = `你是一个顶级的同声传译员。
【核心任务】：你接收到的文本是英语，请将其翻译为流畅、准确的简体中文。
【规则与限制】：
1. 绝对禁止直接复制粘贴整句原文。输出必须以中文句子结构为主。
2. 允许并鼓励保留英文原语中的专业术语、专有名词和常见缩写（如 IT、CEO、名称等）。
3. 绝对禁止输出“好的”、“翻译如下”等任何废话。直接给出最终译文。`

export const ZH_TO_EN_SYSTEM_PROMPT = `你是一个顶级的同声传译员。
【核心任务】：你接收到的文本是中文，请将其翻译为地道、专业的英文。
【规则与限制】：
1. 绝对禁止直接复制粘贴整句原文。
2. 允许保留必要的中文拼音或特定的文化名词。
3. 绝对禁止输出任何废话。直接给出最终译文。`

export function systemPromptForDirection(direction: TranslationDirection): string {
  return direction === 'zh-en' ? ZH_TO_EN_SYSTEM_PROMPT : EN_TO_ZH_SYSTEM_PROMPT
}

export function directionLabel(direction: TranslationDirection): string {
  return direction === 'zh-en' ? '中译英 (ZH → EN)' : '英译中 (EN → ZH)'
}

/**
 * Smart routing: mainMode is the UI primary direction;
 * Auto-LID may reverse when the speaker switches language mid-meeting.
 *
 * EN→ZH main: zh → reverse to ZH→EN; en/unknown → keep EN→ZH
 * ZH→EN main: en → reverse to EN→ZH; zh/unknown → keep ZH→EN
 */
export function resolveActualDirection(
  mainMode: TranslationDirection,
  detected: DetectedLanguage
): TranslationDirection {
  if (mainMode === 'en-zh') {
    return detected === 'zh' ? 'zh-en' : 'en-zh'
  }
  return detected === 'en' ? 'en-zh' : 'zh-en'
}

/** Target language of a translation direction (for UI tags on output). */
export function targetLangOfDirection(
  direction: TranslationDirection
): Exclude<DetectedLanguage, 'unknown'> {
  return direction === 'zh-en' ? 'en' : 'zh'
}

export function resolveTranslationRoute(sourceText: string, mainMode: TranslationDirection): {
  detected: DetectedLanguage
  actualDirection: TranslationDirection
  reversed: boolean
  systemPrompt: string
} {
  const detected = detectLanguage(sourceText)
  const actualDirection = resolveActualDirection(mainMode, detected)
  return {
    detected,
    actualDirection,
    reversed: actualDirection !== mainMode,
    systemPrompt: systemPromptForDirection(actualDirection)
  }
}

/** Strip spaces / punctuation for echo comparison */
export function normalizeForCompare(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * Anti-repetition: discard if LLM echoed source verbatim
 * (exact match after normalize, or translation fully contained as copy of source).
 */
export function isEchoRepetition(sourceText: string, translatedText: string): boolean {
  const src = sourceText.trim()
  const out = translatedText.trim()
  if (!src || !out) return false

  const nSrc = normalizeForCompare(src)
  const nOut = normalizeForCompare(out)
  if (!nSrc || !nOut) return false

  // Exact copy
  if (nOut === nSrc) return true

  // Output is verbatim substring of source (whole-sentence paste)
  if (nSrc.includes(nOut) && nOut.length >= Math.min(12, nSrc.length)) {
    // Also require high overlap ratio to avoid killing short valid terms
    if (nOut.length / nSrc.length >= 0.85) return true
  }

  // Raw trim equality (keeps casing/punct differences only)
  if (out === src) return true

  return false
}

export function buildTranslateUserContent(
  unit: string,
  history: string[],
  direction: TranslationDirection
): string {
  const task =
    direction === 'zh-en'
      ? '请将【最新一句】从中文翻译为英文'
      : '请将【最新一句】从英文翻译为简体中文'

  if (history.length === 0) {
    return `${task}（只输出译文）：\n${unit}`
  }
  return `【上文】\n${history.join('\n')}\n\n【${task}】\n${unit}`
}
