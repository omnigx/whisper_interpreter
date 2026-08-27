import { useEffect, useRef, type RefObject } from 'react'

/** Close when pointer goes down outside the referenced element. */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  onOutside: () => void
): void {
  useEffect(() => {
    if (!enabled) return
    const onDown = (e: MouseEvent): void => {
      const el = ref.current
      if (!el) return
      if (el.contains(e.target as Node)) return
      onOutside()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [enabled, onOutside, ref])
}
