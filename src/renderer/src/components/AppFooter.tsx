import {
  derivePipelineMode,
  getActiveLlm,
  pipelineModeLabel
} from '@shared/types'
import { useAppStore } from '../stores/appStore'
import { useNetworkMonitor } from '../hooks/useNetworkMonitor'

interface AppFooterProps {
  onOpenSettings: () => void
  onRestartListening?: () => void
}

/** Bottom status strip — network / engine / STT·LLM (moved from top). */
export function AppFooter({
  onOpenSettings,
  onRestartListening
}: AppFooterProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const degraded = useAppStore((s) => s.degraded)
  const isListening = useAppStore((s) => s.isListening)
  const degradeToOffline = useAppStore((s) => s.degradeToOffline)
  const restoreCloudPreferred = useAppStore((s) => s.restoreCloudPreferred)

  const { network, cloudReachable, localLlmReachable } = useNetworkMonitor()

  const activeLlm = getActiveLlm(settings)
  const mode = derivePipelineMode(settings.stt, activeLlm)
  const modeOnline = mode === 'cloud' || mode === 'hybrid-cloud-stt'

  const netDot =
    network === 'offline'
      ? 'bg-red-400'
      : cloudReachable === false
        ? 'bg-amber-400'
        : 'bg-emerald-400'

  const engineDot = degraded || mode === 'offline' ? 'bg-orange-400' : 'bg-emerald-400'

  const handleDegrade = (): void => {
    degradeToOffline()
    if (isListening) onRestartListening?.()
  }

  const handleRestore = (): void => {
    restoreCloudPreferred()
    if (isListening) onRestartListening?.()
  }

  return (
    <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-[var(--border)] bg-[var(--bg-panel)] px-3 text-[11px] text-[var(--text-muted)]">
      <span className="inline-flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${netDot}`} />
        网络 {network === 'offline' ? '离线' : cloudReachable === false ? '弱网' : '在线'}
      </span>

      <span className="inline-flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${engineDot}`} />
        {pipelineModeLabel(mode)}
        {degraded ? ' · 已降级' : ''}
      </span>

      <span className="truncate">
        STT {settings.stt.provider} · LLM {activeLlm?.model ?? '—'}
      </span>

      <span className="hidden text-[var(--text-muted)]/60 sm:inline">
        云{cloudReachable == null ? '—' : cloudReachable ? '✓' : '✗'} · 本地
        {localLlmReachable == null ? '—' : localLlmReachable ? '✓' : '✗'}
      </span>

      <div className="ml-auto flex items-center gap-1.5">
        {(network === 'offline' || cloudReachable === false) && !degraded && modeOnline && (
          <button
            type="button"
            onClick={handleDegrade}
            className="rounded border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 text-[10px] text-orange-200 hover:bg-orange-500/20"
          >
            降级离线
          </button>
        )}
        {degraded && (
          <button
            type="button"
            onClick={handleRestore}
            className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-200 hover:bg-emerald-500/20"
          >
            恢复云端
          </button>
        )}
        <button
          type="button"
          onClick={onOpenSettings}
          className="rounded border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          引擎设置
        </button>
      </div>
    </footer>
  )
}
