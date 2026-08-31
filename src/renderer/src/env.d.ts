/// <reference types="vite/client" />

import type { CSSProperties } from 'react'

/**
 * Electron frameless-window drag regions use a non-standard CSS property.
 * Expose it to React's style typing so object literals typecheck.
 */
declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag'
  }
}
