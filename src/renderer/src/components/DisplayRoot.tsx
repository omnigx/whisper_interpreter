import type { ReactNode } from 'react'

/**
 * Display settings (fonts / size / line-height) are scoped to content panels
 * in FullSizeMode — never applied to body or chrome UI.
 */
export function DisplayRoot({ children }: { children: ReactNode }): React.JSX.Element {
  return <>{children}</>
}
