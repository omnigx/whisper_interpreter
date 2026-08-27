import type { WhisperApi } from './index'

declare global {
  interface Window {
    whisperApi: WhisperApi
  }
}

export {}
