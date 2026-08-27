import type { LlmEndpointConfig } from '@shared/types'
import { useAppStore } from '../stores/appStore'

function api(): Window['whisperApi'] | undefined {
  return typeof window !== 'undefined' ? window.whisperApi : undefined
}

/** Persist plaintext key for a provider (deepseek / gemini / …). Empty clears vault. */
export async function saveProviderApiKey(
  provider: string,
  key: string
): Promise<boolean> {
  const bridge = api()
  if (!bridge?.saveApiKey) return false
  const res = await bridge.saveApiKey(provider, key.trim())
  return Boolean(res?.ok)
}

export async function loadProviderApiKey(provider: string): Promise<string | null> {
  const bridge = api()
  if (!bridge?.getApiKey) return null
  const key = await bridge.getApiKey(provider)
  return key?.trim() ? key.trim() : null
}

/** Apply a provider key onto every matching LLM endpoint in the zustand store. */
export function applyProviderApiKeyToStore(provider: string, key: string): void {
  const { settings, updateLlm } = useAppStore.getState()
  for (const llm of settings.llms) {
    if (llm.provider === provider && llm.apiKey !== key) {
      updateLlm(llm.id, { apiKey: key })
    }
  }
}

/** Boot / focus: pull encrypted keys into memory for all cloud LLM providers. */
export async function hydrateApiKeysFromSecureStore(): Promise<void> {
  const bridge = api()
  if (!bridge?.getApiKey) return

  const providers = [
    ...new Set(
      useAppStore
        .getState()
        .settings.llms.filter((l) => l.tier === 'cloud')
        .map((l) => l.provider)
    )
  ]

  for (const provider of providers) {
    try {
      const key = await loadProviderApiKey(provider)
      if (key) applyProviderApiKeyToStore(provider, key)
    } catch (e) {
      console.warn('[secure-api-keys] hydrate failed for', provider, e)
    }
  }
}

/**
 * Before an LLM request: if memory has no key, try the vault once.
 * Returns a config copy with apiKey filled when possible.
 */
export async function ensureLlmApiKey(
  cfg: LlmEndpointConfig
): Promise<LlmEndpointConfig> {
  if (cfg.provider === 'ollama') return cfg
  if (cfg.apiKey.trim()) return cfg

  const key = await loadProviderApiKey(cfg.provider)
  if (!key) return cfg

  applyProviderApiKeyToStore(cfg.provider, key)
  return { ...cfg, apiKey: key }
}
