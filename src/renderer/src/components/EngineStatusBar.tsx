import {
  derivePipelineMode,
  getActiveLlm,
  pipelineModeLabel
} from '@shared/types'
import { useAppStore } from '../stores/appStore'
import { useNetworkMonitor } from '../hooks/useNetworkMonitor'

interface EngineStatusBarProps {
  onOpenSettings: () => void
  onRestartListening?: () => void
}

export function EngineStatusBar({
  onOpenSettings,
  onRestartListening
}: EngineStatusBarProps): React.JSX.Element {
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
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-panel)]/90 px-4 py-1.5 text-[11px]">
      <span className="inline-flex items-center gap-1.5 text-[var(--text-muted)]">
        <span className={`h-2 w-2 rounded-full ${netDot}`} />
        网络 {network === 'offline' ? '离线' : cloudReachable === false ? '弱网/云端异常' : '在线'}
      </span>

      <span className="inline-flex items-center gap-1.5 text-[var(--text-muted)]">
        <span className={`h-2 w-2 rounded-full ${engineDot}`} />
        {modeOnline && !degraded ? '🟢' : '🟠'} {pipelineModeLabel(mode)}
        {degraded ? '（已降级）' : ''}
      </span>

      <span className="text-[var(--text-muted)]">
        STT {settings.stt.provider} · LLM {activeLlm?.model ?? '—'}
      </span>

      <span className="text-[var(--text-muted)]/70">
        云端{cloudReachable == null ? '—' : cloudReachable ? '✓' : '✗'} · 本地LLM
        {localLlmReachable == null ? '—' : localLlmReachable ? '✓' : '✗'}
      </span>

      <div className="ml-auto flex items-center gap-2">
        {(network === 'offline' || cloudReachable === false) && !degraded && modeOnline && (
          <button
            type="button"
            onClick={handleDegrade}
            className="rounded border border-orange-500/40 bg-orange-500/15 px-2 py-0.5 text-orange-200 hover:bg-orange-500/25"
          >
            一键降级离线
          </button>
        )}
        {degraded && (
          <button
            type="button"
            onClick={handleRestore}
            className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-emerald-200 hover:bg-emerald-500/20"
          >
            恢复云端
          </button>
        )}
        <button
          type="button"
          onClick={onOpenSettings}
          className="rounded border border-[var(--border)] px-2 py-0.5 text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          引擎设置
        </button>
      </div>
    </div>
  )
}
