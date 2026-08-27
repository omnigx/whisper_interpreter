import { app, ipcMain, safeStorage } from 'electron'
import Store from 'electron-store'

type SecureStoreSchema = {
  /** provider → encrypted payload (base64), or `plain:` + base64 when OS crypto unavailable */
  encryptedApiKeys: Record<string, string>
}

let store: Store<SecureStoreSchema> | null = null

function getStore(): Store<SecureStoreSchema> {
  if (!store) {
    store = new Store<SecureStoreSchema>({
      name: 'secure-credentials',
      defaults: { encryptedApiKeys: {} }
    })
  }
  return store
}

function normalizeProvider(provider: unknown): string {
  return String(provider ?? '')
    .trim()
    .toLowerCase()
}

function encryptForDisk(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    const buf = safeStorage.encryptString(plain)
    return `safe:${buf.toString('base64')}`
  }
  // Fallback for locked-down / headless OS builds — not OS-keychain grade
  console.warn(
    '[secure-api-keys] safeStorage unavailable; storing API key as local base64 fallback'
  )
  return `plain:${Buffer.from(plain, 'utf8').toString('base64')}`
}

function decryptFromDisk(payload: string): string | null {
  if (!payload) return null
  try {
    if (payload.startsWith('safe:')) {
      if (!safeStorage.isEncryptionAvailable()) {
        console.error('[secure-api-keys] encrypted key present but safeStorage unavailable')
        return null
      }
      const buf = Buffer.from(payload.slice('safe:'.length), 'base64')
      return safeStorage.decryptString(buf)
    }
    if (payload.startsWith('plain:')) {
      return Buffer.from(payload.slice('plain:'.length), 'base64').toString('utf8')
    }
    // Legacy: raw base64 from older builds
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(payload, 'base64'))
    }
    return Buffer.from(payload, 'base64').toString('utf8')
  } catch (e) {
    console.error('[secure-api-keys] decrypt failed', e)
    return null
  }
}

export function registerSecureApiKeyIpc(): void {
  ipcMain.handle(
    'save-api-key',
    (_event, provider: unknown, apiKey: unknown): { ok: boolean; reason?: string } => {
      if (!app.isReady()) {
        return { ok: false, reason: 'app-not-ready' }
      }
      const id = normalizeProvider(provider)
      if (!id) return { ok: false, reason: 'invalid-provider' }

      const key = String(apiKey ?? '').trim()
      const s = getStore()
      const map = { ...(s.get('encryptedApiKeys') ?? {}) }

      if (!key) {
        delete map[id]
        s.set('encryptedApiKeys', map)
        return { ok: true }
      }

      map[id] = encryptForDisk(key)
      s.set('encryptedApiKeys', map)
      return { ok: true }
    }
  )

  ipcMain.handle('get-api-key', (_event, provider: unknown): string | null => {
    if (!app.isReady()) return null
    const id = normalizeProvider(provider)
    if (!id) return null
    const payload = getStore().get('encryptedApiKeys')?.[id]
    if (!payload) return null
    const plain = decryptFromDisk(payload)
    return plain?.trim() ? plain.trim() : null
  })

  ipcMain.handle('is-api-key-encryption-available', (): boolean => {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  })
}
