/** Robust clipboard write for Electron renderer (Clipboard API often denied). */
export async function copyTextToClipboard(text: string): Promise<void> {
  const value = text ?? ''
  if (!value) throw new Error('empty')

  // Prefer main-process clipboard via preload (most reliable in Electron)
  if (typeof window.whisperApi?.writeClipboardText === 'function') {
    await window.whisperApi.writeClipboardText(value)
    return
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return
    }
  } catch {
    /* fall through */
  }

  // Legacy DOM fallback
  const ta = document.createElement('textarea')
  ta.value = value
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.left = '-9999px'
  ta.style.top = '0'
  document.body.appendChild(ta)
  ta.select()
  ta.setSelectionRange(0, value.length)
  const ok = document.execCommand('copy')
  document.body.removeChild(ta)
  if (!ok) throw new Error('execCommand copy failed')
}
