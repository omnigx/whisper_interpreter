import { useAppStore } from '../stores/appStore'

interface AudioControlPanelProps {
  devices: MediaDeviceInfo[]
  inputLevel: number
  pcmRms: number
  framesEmitted: number
  contextSampleRate: number
  vadSegmentCount: number
  vadEngine?: 'silero' | 'energy' | null
  onVolume: (v: number) => void
  onGain: (g: number) => void
  onMaxSentence: (ms: number) => void
  onDevice: (deviceId: string) => void
  onRefreshDevices: () => void
}

/** Discrete nonlinear gain steps (ear-friendly). */
export const GAIN_STEPS: number[] = (() => {
  const steps: number[] = []
  for (let g = 0; g <= 2; g += 0.25) {
    steps.push(Number(g.toFixed(2)))
  }
  for (let g = 2.5; g <= 8; g += 0.5) {
    steps.push(Number(g.toFixed(1)))
  }
  return steps
})()

function gainToIndex(gain: number): number {
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < GAIN_STEPS.length; i++) {
    const d = Math.abs(GAIN_STEPS[i] - gain)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  }
  return best
}

function formatGain(g: number): string {
  if (Number.isInteger(g) || Math.abs(g - Math.round(g)) < 1e-9) {
    return `x${Math.round(g)}.0`
  }
  const s = g.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  return `x${s}`
}

const LABEL = 'text-[10px] tracking-wider text-[var(--text-muted)]'

export function AudioControlPanel({
  devices,
  inputLevel,
  pcmRms,
  framesEmitted,
  contextSampleRate,
  vadSegmentCount,
  vadEngine,
  onVolume,
  onGain,
  onMaxSentence,
  onDevice,
  onRefreshDevices
}: AudioControlPanelProps): React.JSX.Element {
  const audio = useAppStore((s) => s.settings.audio)
  const isListening = useAppStore((s) => s.isListening)
  const levelPct = Math.min(100, Math.round(inputLevel * 140))
  const rmsPct = Math.min(100, Math.round(pcmRms * 400))
  const gainIndex = gainToIndex(audio.gain)
  const gainValue = GAIN_STEPS[gainIndex] ?? audio.gain

  return (
    <div className="flex flex-wrap items-center gap-4 border-b border-[var(--border)] bg-[var(--bg-panel)] px-4 py-2">
      {/* 1. 输入电平 */}
      <div className="flex w-44 shrink-0 flex-col gap-0.5">
        <div className={`flex items-center justify-between ${LABEL}`}>
          <span>输入电平</span>
          <span className="tabular-nums tracking-normal">{levelPct}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded bg-[var(--bg-deep)]">
          <div
            className={`h-full transition-[width] duration-75 ${
              levelPct > 85 ? 'bg-red-400' : levelPct > 55 ? 'bg-amber-400' : 'bg-emerald-400'
            }`}
            style={{ width: `${isListening ? levelPct : 0}%` }}
          />
        </div>
        <div className="h-0.5 overflow-hidden rounded bg-[var(--bg-deep)]">
          <div
            className="h-full bg-[var(--accent)]/70 transition-[width] duration-75"
            style={{ width: `${isListening ? rmsPct : 0}%` }}
            title="PCM RMS"
          />
        </div>
      </div>

      {/* 2. 麦克风 */}
      <div className="flex w-36 shrink-0 flex-col gap-0.5">
        <span className={LABEL}>麦克风</span>
        <div className="flex items-center gap-1">
          <select
            className="w-full max-w-[140px] truncate rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[11px] text-[var(--text)]"
            value={audio.deviceId}
            onChange={(e) => onDevice(e.target.value)}
          >
            <option value="">系统默认</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `输入设备 ${d.deviceId.slice(0, 8)}`}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onRefreshDevices}
            className="shrink-0 whitespace-nowrap rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]"
            title="刷新设备列表"
          >
            刷新
          </button>
        </div>
      </div>

      {/* 3. Volume | Gain | Segment — equal-width cells */}
      <div className="flex shrink-0 items-end gap-8">
        <div className="flex w-40 flex-col gap-0.5">
          <div className={`flex items-center justify-between ${LABEL}`}>
            <span>音量 Volume</span>
            <span className="tabular-nums tracking-normal text-[var(--text)]">
              {Math.round(audio.volume * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={audio.volume}
            onChange={(e) => onVolume(Number(e.target.value))}
            className="w-full accent-[var(--accent)]"
          />
        </div>

        <div className="flex w-40 flex-col gap-0.5">
          <div className={`flex items-center justify-between ${LABEL}`}>
            <span>增益 Gain</span>
            <span className="tabular-nums tracking-normal text-[var(--text)]">
              {formatGain(gainValue)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={GAIN_STEPS.length - 1}
            step={1}
            value={gainIndex}
            onChange={(e) => {
              const idx = Number(e.target.value)
              const next = GAIN_STEPS[idx]
              if (typeof next === 'number') onGain(next)
            }}
            className="w-full accent-[var(--accent)]"
            title="低增益细调 0.25；2× 以上粗调 0.5"
          />
        </div>

        <div className="flex w-40 flex-col gap-0.5">
          <div className={`flex items-center justify-between ${LABEL}`}>
            <span>片段 Segment</span>
            <span className="tabular-nums tracking-normal text-[var(--text)]">
              {audio.maxSentenceMs / 1000}s
            </span>
          </div>
          <input
            type="range"
            min={5}
            max={30}
            step={1}
            value={audio.maxSentenceMs / 1000}
            onChange={(e) => onMaxSentence(Number(e.target.value) * 1000)}
            className="w-full accent-[var(--accent)]"
          />
        </div>
      </div>

      {/* 4. PCM / VAD — 贴右 */}
      <div className="ml-auto flex shrink-0 flex-col items-end gap-0 text-[10px] leading-tight text-[var(--text-muted)]">
        <span className="whitespace-nowrap">
          PCM {TARGET_LABEL(contextSampleRate)} · 帧 {framesEmitted}
        </span>
        <span className="whitespace-nowrap">
          VAD {vadEngine ?? '—'} · 切段 {vadSegmentCount}
        </span>
      </div>
    </div>
  )
}

function TARGET_LABEL(contextRate: number): string {
  return contextRate === 16000 ? '16kHz' : `ctx ${contextRate}Hz→16kHz`
}
