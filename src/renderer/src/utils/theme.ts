/**
 * Dark / light theme (印刷演示：浅色模式). The choice lives on
 * document.documentElement[data-theme] so both windows (main + subtitle)
 * switch together; persistence is a plain localStorage key, applied before
 * React renders to avoid a dark flash in light mode.
 */

export type AppTheme = 'dark' | 'light'

const THEME_KEY = 'whisper-theme'

export function storedTheme(): AppTheme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export function applyTheme(theme: AppTheme): void {
  document.documentElement.dataset.theme = theme
}

export function setTheme(theme: AppTheme): void {
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    /* ignore */
  }
  applyTheme(theme)
}

/** Call once per window before createRoot so the first paint is correct. */
export function initTheme(): void {
  applyTheme(storedTheme())
}
