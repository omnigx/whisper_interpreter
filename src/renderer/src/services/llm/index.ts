import {
  TERM_EXTRACT_PROMPT,
  normalizeLocalWsUrl,
  type LlmEndpointConfig
} from '@shared/types'

export interface LlmClient {
  readonly id: string
  readonly label: string
  translateStream: (
    text: string,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
    options?: { systemPrompt?: string }
  ) => Promise<string>
  extractTerms: (
    text: string,
    signal?: AbortSignal
  ) => Promise<Array<{ foreignText: string; chineseText: string }>>
  /** Lightweight connectivity probe */
  ping: () => Promise<boolean>
}

/**
 * Unified OpenAI-compatible LLM adapter.
 * Works with DeepSeek, Gemini (OpenAI compat), Ollama, LM Studio, etc.
 * Switching models = swap baseUrl / apiKey / model — streaming UI unchanged.
 */
export function createOpenAiCompatibleClient(config: LlmEndpointConfig): LlmClient {
  const baseUrl = normalizeBaseUrl(normalizeLocalWsUrl(config.baseUrl))

  async function chatCompletion(params: {
    messages: Array<{ role: string; content: string }>
    stream: boolean
    onChunk?: (chunk: string) => void
    signal?: AbortSignal
    temperature?: number
  }): Promise<string> {
    // Demo path when cloud key missing (local ollama may still work with dummy key)
    if (
      config.tier === 'cloud' &&
      !config.apiKey.trim() &&
      config.provider !== 'ollama'
    ) {
      const stub = `[未配置 ${config.label} API Key] ${params.messages.at(-1)?.content ?? ''}`
      params.onChunk?.(stub)
      return stub
    }

    const url = `${baseUrl}/chat/completions`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (config.apiKey.trim()) {
      headers.Authorization = `Bearer ${config.apiKey.trim()}`
    }

    const body = {
      model: config.model,
      messages: params.messages,
      stream: params.stream,
      temperature: params.temperature ?? 0.2
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: params.signal
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`${config.label} HTTP ${res.status}: ${errText.slice(0, 200)}`)
    }

    if (!params.stream) {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      return json.choices?.[0]?.message?.content?.trim() ?? ''
    }

    if (!res.body) throw new Error(`${config.label} 无流式响应体`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let full = ''
    let buffer = ''

    const onAbort = (): void => {
      void reader.cancel().catch(() => undefined)
    }
    params.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      while (true) {
        if (params.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError')
        }
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const raw of lines) {
          const line = raw.trim()
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue
          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>
            }
            const piece = parsed.choices?.[0]?.delta?.content
            if (piece) {
              full += piece
              params.onChunk?.(piece)
            }
          } catch {
            /* ignore partial JSON */
          }
        }
      }
    } finally {
      params.signal?.removeEventListener('abort', onAbort)
    }

    return full
  }

  return {
    id: config.id,
    label: config.label,

    async translateStream(text, onChunk, signal, options) {
      return chatCompletion({
        messages: [
          {
            role: 'system',
            content: options?.systemPrompt?.trim() || config.systemPrompt
          },
          { role: 'user', content: text }
        ],
        stream: true,
        onChunk,
        signal,
        temperature: 0.2
      })
    },

    async extractTerms(text, signal) {
      try {
        const raw = await chatCompletion({
          messages: [
            { role: 'system', content: TERM_EXTRACT_PROMPT },
            {
              role: 'user',
              content: `待提取文本：\n${text}`
            }
          ],
          stream: false,
          signal,
          temperature: 0
        })
        console.debug('[term-extract] raw reply', raw.slice(0, 400))
        return parseTermsJson(raw)
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e
        console.error('[term-extract] LLM 请求异常', e)
        return []
      }
    },

    async ping() {
      try {
        // Prefer models list (cheap); fall back to tiny completion
        const headers: Record<string, string> = {}
        if (config.apiKey.trim()) {
          headers.Authorization = `Bearer ${config.apiKey.trim()}`
        }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 2500)
        const res = await fetch(`${baseUrl}/models`, {
          headers,
          signal: controller.signal
        })
        clearTimeout(timer)
        return res.ok || res.status === 401 || res.status === 404
      } catch {
        return false
      }
    }
  }
}

export function createLlmClient(config: LlmEndpointConfig): LlmClient {
  return createOpenAiCompatibleClient(config)
}

/** Strip `/v1` so we can hit Ollama native APIs (`/api/tags`). Prefer 127.0.0.1 on Windows. */
export function ollamaApiRoot(baseUrl = 'http://127.0.0.1:11434/v1'): string {
  const normalized = normalizeLocalWsUrl(baseUrl)
  const trimmed = normalized.replace(/\/+$/, '')
  const withoutV1 = trimmed.replace(/\/v1$/i, '')
  return withoutV1 || 'http://127.0.0.1:11434'
}

/**
 * List locally installed Ollama models via GET /api/tags.
 */
export async function fetchOllamaModels(
  baseUrl = 'http://127.0.0.1:11434/v1',
  signal?: AbortSignal
): Promise<string[]> {
  const root = ollamaApiRoot(baseUrl)
  const res = await fetch(`${root}/api/tags`, { signal })
  if (!res.ok) {
    throw new Error(`Ollama /api/tags HTTP ${res.status}`)
  }
  const json = (await res.json()) as {
    models?: Array<{ name?: string; model?: string }>
  }
  const names = (json.models ?? [])
    .map((m) => m.name?.trim() || m.model?.trim())
    .filter((n): n is string => Boolean(n))
  return [...new Set(names)]
}

/** Prefer a 7b tag when choosing an initial model from a list. */
export function pickPreferredOllamaModel(
  names: string[],
  current?: string
): string | undefined {
  if (current && names.includes(current)) return current
  return names.find((n) => /7b/i.test(n)) ?? names[0]
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

function parseTermsJson(raw: string): Array<{ foreignText: string; chineseText: string }> {
  if (!raw?.trim()) return []

  try {
    // Strip markdown fences and common wrappers
    let sanitized = raw
      .replace(/```(?:json)?\s*/gi, '')
      .replace(/```/g, '')
      .trim()

    const startIndex = sanitized.indexOf('[')
    const endIndex = sanitized.lastIndexOf(']')
    if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
      console.error('[term-extract] 未找到 JSON 数组', raw.slice(0, 500))
      return []
    }

    const jsonString = sanitized.substring(startIndex, endIndex + 1)
    const arr = JSON.parse(jsonString) as unknown
    if (!Array.isArray(arr)) {
      console.error('[term-extract] 根节点不是数组', jsonString.slice(0, 300))
      return []
    }

    return arr
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return { foreignText: '', chineseText: '' }
        }
        const x = item as {
          foreignText?: string
          chineseText?: string
          source?: string
          target?: string
        }
        const foreign = String(x.foreignText ?? x.source ?? '').trim()
        const chinese = String(x.chineseText ?? x.target ?? '').trim()
        return { foreignText: foreign, chineseText: chinese }
      })
      .filter((x) => x.foreignText && x.chineseText)
  } catch (error) {
    console.error('LLM 术语提取解析失败:', error, raw.slice(0, 800))
    return []
  }
}
