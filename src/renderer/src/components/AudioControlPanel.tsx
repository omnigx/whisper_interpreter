import { useEffect, useRef } from 'react'
import {
  VAD_SILENCE_MIN_MS,
  VAD_SILENCE_MAX_MS,
  VAD_SILENCE_STEP_MS
} from '@shared/types'
import { useAppStore } from '../stores/appStore'
import { subscribeMeter, type MeterSnapshot } from '../services/meterBus'

interface AudioControlPanelProps {
  devices: MediaDeviceInfo[]
  vadSegmentCount: number
  vadEngine?: 'silero' | 'energy' | null
  onGain: (g: number) => void
  onMaxSentence: (ms: number) => void
  onSilence: (ms: number) => void
  onDevice: (deviceId: string) => void
  onRefreshDevices: () => void
  /** Toggle sync recording (may start/stop mid-session) */
  onSyncRecordingChange?: (enabled: boolean) => void
}

/**
 * Discrete gain steps. Below 1× the slider attenuates in 0.1 steps (the duty
 * formerly covered by the removed volume slider, since gain × volume multiply
 * in series). Above 1× the original amplification ladder is kept: 0.25 steps
 * up to 2×, then 0.5 steps up to 8×.
 */
export const GAIN_STEPS: number[] = (() => {
  const steps: number[] = []
  for (let g = 0; g <= 1.0001; g += 0.1) {
    steps.push(Number(g.toFixed(2)))
  }
  for (let g = 1.25; g <= 2.0001; g += 0.25) {
    steps.push(Number(g.toFixed(2)))
  }
  for (let g = 2.5; g <= 8.0001; g += 0.5) {
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
  vadSegmentCount,
  vadEngine,
  onGain,
  onMaxSentence,
  onSilence,
  onDevice,
  onRefreshDevices,
  onSyncRecordingChange
}: AudioControlPanelProps): React.JSX.Element {
  const audio = useAppStore((s) => s.settings.audio)
  const setAudio = useAppStore((s) => s.setAudio)
  const isListening = useAppStore((s) => s.isListening)
  // Debug text only — meters paint via meterBus without React
  const framesEmitted = useAppStore((s) => s.framesEmitted)
  const contextSampleRate = useAppStore((s) => s.contextSampleRate)
  const gainIndex = gainToIndex(audio.gain)
  const gainValue = GAIN_STEPS[gainIndex] ?? audio.gain
  const syncRecording = Boolean(audio.syncRecording)

  return (
    <div className="flex items-center gap-4 border-b border-[var(--border)] bg-[var(--bg-panel)] px-4 py-2">
      {/* 左半（原始音频）：电平 / 麦克风 / 同步录音 / 增益 —— 半区等宽，
          右缘即分割线，与主内容区两栏分界（窗口 50%）同一轴线 */}
      <div className="flex min-w-0 flex-1 items-center gap-4">
      {/* 1. 输入电平 */}
      <LevelMeter active={isListening} />

      {/* 2. 麦克风 + 输入源 */}
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

      {/* 2b. 输入源已移至顶栏「输入源」按钮（会前预配置项，不占常驻空间） */}

      {/* 2c. 同步录音（格式在顶栏「录音设置」中配置） */}
      <div className="flex shrink-0 flex-col gap-0.5">
        <span className={LABEL}>同步录音</span>
        <label className="inline-flex h-[26px] cursor-pointer items-center gap-1.5 text-[11px] text-[var(--text)]">
          <input
            type="checkbox"
            className="accent-[var(--accent)]"
            checked={syncRecording}
            onChange={(e) => {
              const enabled = e.target.checked
              if (onSyncRecordingChange) {
                void onSyncRecordingChange(enabled)
              } else {
                setAudio({ syncRecording: enabled })
              }
            }}
          />
          启用
        </label>
      </div>

      {/* 3. 增益 —— 撑满左半剩余宽度，右端正好落在分割线。
          音量滑块已移除：外接音源自带硬件音量，软件侧由增益覆盖（<1× 即衰减） */}
        <div className="flex min-w-32 flex-1 flex-col gap-0.5">
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
            title="1× 以下按 0.1 细调衰减（替代音量），1–2× 每 0.25，2.5× 起每 0.5 至 8×。音量请用 Bosch 主机硬件旋钮"
          />
        </div>
      </div>

      <div className="w-px shrink-0 self-stretch bg-[var(--border)]" aria-hidden="true" />

      {/* 右半（语义拆分）：片段 / 断句停顿 / PCM+VAD 贴右 */}
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <div className="flex min-w-32 flex-1 flex-col gap-0.5">
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

        <div className="flex min-w-32 flex-1 flex-col gap-0.5">
          <div className={`flex items-center justify-between ${LABEL}`}>
            <span>断句停顿 Silence</span>
            <span className="tabular-nums tracking-normal text-[var(--text)]">
              {(audio.vadSilenceMs / 1000).toFixed(2)}s
            </span>
          </div>
          <input
            type="range"
            min={VAD_SILENCE_MIN_MS / 1000}
            max={VAD_SILENCE_MAX_MS / 1000}
            step={VAD_SILENCE_STEP_MS / 1000}
            value={audio.vadSilenceMs / 1000}
            onChange={(e) => onSilence(Number(e.target.value) * 1000)}
            className="w-full accent-[var(--accent)]"
            title="静音达到该时长即断句送译：快语速讲者 0.4–0.6s；一般 0.7–0.9s；非母语/慢速 1.0–1.5s。对整句(SenseVoice/FW)与流式(Paraformer)同时生效。"
          />
        </div>

        {/* 4. PCM / VAD — 贴右（右半内，位置不变） */}
        <div className="ml-auto flex shrink-0 flex-col items-end gap-0 text-[10px] leading-tight text-[var(--text-muted)]">
          <span className="whitespace-nowrap">
            PCM {TARGET_LABEL(contextSampleRate)} · 帧 {framesEmitted}
          </span>
          <span className="whitespace-nowrap">
            VAD {vadEngine ?? '—'} · 切段 {vadSegmentCount}
          </span>
        </div>
      </div>
    </div>
  )
}

function TARGET_LABEL(contextRate: number): string {
  return contextRate === 16000 ? '16kHz' : `ctx ${contextRate}Hz→16kHz`
}

/**
 * Input-level meter. Bars + percentage are painted imperatively from meterBus
 * at the capture cadence (50 ms) — zero React re-renders on the hot path, so
 * the animation stays fluid even though it never touches component state.
 * React only owns the initial / inactive (0%) state.
 */
function LevelMeter({ active }: { active: boolean }): React.JSX.Element {
  const levelBarRef = useRef<HTMLDivElement>(null)
  const rmsBarRef = useRef<HTMLDivElement>(null)
  const pctRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!active) {
      if (levelBarRef.current) levelBarRef.current.style.width = '0%'
      if (rmsBarRef.current) rmsBarRef.current.style.width = '0%'
      if (pctRef.current) pctRef.current.textContent = '0%'
      return
    }
    const paint = (snap: MeterSnapshot): void => {
      const pct = Math.min(100, Math.round(snap.inputLevel * 140))
      const bar = levelBarRef.current
      if (bar) {
        bar.style.width = `${pct}%`
        bar.classList.toggle('bg-red-400', pct > 85)
        bar.classList.toggle('bg-amber-400', pct > 55 && pct <= 85)
        bar.classList.toggle('bg-emerald-400', pct <= 55)
      }
      if (rmsBarRef.current) {
        rmsBarRef.current.style.width = `${Math.min(100, Math.round(snap.pcmRms * 400))}%`
      }
      if (pctRef.current) pctRef.current.textContent = `${pct}%`
    }
    return subscribeMeter(paint)
  }, [active])

  return (
    <div className="flex w-44 shrink-0 flex-col gap-0.5">
      <div className={`flex items-center justify-between ${LABEL}`}>
        <span>输入电平</span>
        <span ref={pctRef} className="tabular-nums tracking-normal">
          0%
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-[var(--bg-deep)]">
        <div
          ref={levelBarRef}
          className="h-full bg-emerald-400 transition-[width] duration-[60ms] ease-linear"
          style={{ width: '0%' }}
        />
      </div>
      <div className="h-0.5 overflow-hidden rounded bg-[var(--bg-deep)]">
        <div
          ref={rmsBarRef}
          className="h-full bg-[var(--accent)]/70 transition-[width] duration-[60ms] ease-linear"
          style={{ width: '0%' }}
          title="PCM RMS"
        />
      </div>
    </div>
  )
}
