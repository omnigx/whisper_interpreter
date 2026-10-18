import { useEffect, useState } from 'react'
import {
  derivePipelineMode,
  getActiveLlm,
  localSttLauncherKey,
  pipelineModeLabel
} from '@shared/types'
import { useAppStore } from '../stores/appStore'
import { useNetworkMonitor } from '../hooks/useNetworkMonitor'

/** Debug mode mirror — toggled from the test page button (main-process
 *  state is the source of truth; this subscribes to a store copy). */
function useDebugMode(): boolean {
  return useAppStore((s) => s.debugMode === true)
}

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

  const sttEngineLaunching = useAppStore((s) => s.sttEngineLaunching)
  const sttLinkStatus = useAppStore((s) => s.sttLinkStatus)
  const isListeningF = isListening

  // 本地 STT 引擎端口探测（3s 一拍，仅本地引擎；云 STT 走连接态）
  const launcherKey = localSttLauncherKey(settings.stt.provider)
  const [enginePortUp, setEnginePortUp] = useState<boolean | null>(null)
  useEffect(() => {
    if (!launcherKey) {
      setEnginePortUp(null)
      return
    }
    let alive = true
    const probe = (): void => {
      void window.whisperApi
        ?.getSttEngineStatus?.(launcherKey)
        .then((r) => {
          if (alive) setEnginePortUp(Boolean(r?.running))
        })
        .catch(() => undefined)
    }
    probe()
    const timer = window.setInterval(probe, 3000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [launcherKey])

  // STT 就绪灯：灰=未启动 · 琥珀=拉起中/连接中 · 绿=就绪（云=已连接）
  const isCloudStt = !launcherKey
  const sttReady = isCloudStt ? sttLinkStatus === 'connected' : enginePortUp === true
  const sttStarting = sttEngineLaunching || (isListeningF && sttLinkStatus !== 'connected' && !sttReady)
  const sttDot = sttReady
    ? 'bg-emerald-400'
    : sttStarting
      ? 'bg-amber-400'
      : 'bg-slate-500'
  const sttLabel = sttReady ? 'STT就绪' : sttStarting ? 'STT启动中' : 'STT未启动'

  // LLM 就绪灯：N/A 隐藏 · 绿=活动端点可达 · 琥珀=不可达/未知
  const llmReachable =
    activeLlm?.provider === 'ollama'
      ? localLlmReachable !== false
      : cloudReachable !== false
  const llmDot = llmReachable ? 'bg-emerald-400' : 'bg-amber-400'

  const recordingUiStatus = useAppStore((s) => s.recordingUiStatus)
  const recordingDot =
    recordingUiStatus === 'recording'
      ? 'bg-red-400'
      : recordingUiStatus === 'saving'
        ? 'bg-amber-400'
        : 'bg-emerald-400'
  const recordingLabel =
    recordingUiStatus === 'recording'
      ? '正在录音'
      : recordingUiStatus === 'saving'
        ? '正在保存'
        : '录音就绪'

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

      <span className="inline-flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${recordingDot}`} />
        {recordingLabel}
      </span>

      <span
        className="inline-flex items-center gap-1.5"
        title={
          sttReady
            ? 'STT 引擎就绪（端口在服务）'
            : sttStarting
              ? 'STT 引擎拉起中，模型加载需 5–60 秒'
              : 'STT 引擎未启动（开始听写时自动拉起）'
        }
      >
        <span className={`h-1.5 w-1.5 rounded-full ${sttDot}`} />
        {sttLabel}
      </span>

      {activeLlm && (
        <span
          className="inline-flex items-center gap-1.5"
          title={
            llmReachable
              ? `LLM 就绪 · ${activeLlm.model}`
              : 'LLM 端点不可达——请确认 Ollama/网络已启动'
          }
        >
          <span className={`h-1.5 w-1.5 rounded-full ${llmDot}`} />
          LLM就绪
        </span>
      )}

      <span
        className="inline-flex items-center gap-1.5"
        title={
          useDebugMode()
            ? 'Debug 模式：新录音存 recordings_debug，新日志存 logs_debug（在测试页切换）'
            : 'Debug 模式未开启（在测试页的 debug 按钮切换）'
        }
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            useDebugMode() ? 'bg-amber-400' : 'bg-slate-500'
          }`}
        />
        DEBUG
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
