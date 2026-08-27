import { useEffect, type RefObject } from 'react'
import { useAppStore } from '../stores/appStore'

const MIN_SIZE = 12
const MAX_SIZE = 36

/**
 * Ctrl + wheel adjusts content fontSize only (not whole-app zoom).
 * Uses native listener with { passive: false } so preventDefault works.
 */
export function useContentWheelZoom(
  sourceRef: RefObject<HTMLElement | null>,
  targetRef: RefObject<HTMLElement | null>,
  termsRef: RefObject<HTMLElement | null>
): void {
  const setDisplay = useAppStore((s) => s.setDisplay)

  useEffect(() => {
    const nodes = [sourceRef.current, targetRef.current, termsRef.current].filter(
      (n): n is HTMLElement => Boolean(n)
    )
    if (nodes.length === 0) return

    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()

      const cur = useAppStore.getState().settings.display.fontSize
      const next =
        e.deltaY < 0
          ? Math.min(cur + 1, MAX_SIZE)
          : Math.max(cur - 1, MIN_SIZE)
      if (next !== cur) setDisplay({ fontSize: next })
    }

    for (const el of nodes) {
      el.addEventListener('wheel', onWheel, { passive: false })
    }
    return () => {
      for (const el of nodes) {
        el.removeEventListener('wheel', onWheel)
      }
    }
  }, [sourceRef, targetRef, termsRef, setDisplay])
}
