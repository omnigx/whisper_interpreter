import { useEffect, useRef, useState } from 'react'
import {
  RECORDING_FORMAT_OPTIONS,
  recordingFormatIdToLabel,
  recordingFormatLabelToId,
  type RecordingFormatId,
  type RecordingFormatLabel
} from '@shared/types'
import { useAppStore } from '../stores/appStore'
import { useClickOutside } from '../hooks/useClickOutside'

/**
 * Header flyout for sync recording + dir + format — same pattern as
 * HeaderEngineSettings.
 */
export function HeaderRecordingSettings({
  onSyncRecordingChange
}: {
  /** Toggle sync recording (starts/stops the PCM file mid-session) */
  onSyncRecordingChange?: (enabled: boolean) => void
} = {}): React.JSX.Element {
  const audio = useAppStore((s) => s.settings.audio)
  const setAudio = useAppStore((s) => s.setAudio)
  const isListening = useAppStore((s) => s.isListening)
  const syncOn = Boolean(audio.syncRecording)
  const recordingBusy = isListening && syncOn

  const [open, setOpen] = useState(false)
  const [dirDisplay, setDirDisplay] = useState(
    audio.recordingDir || 'recordings'
  )
  const rootRef = useRef<HTMLDivElement>(null)

  useClickOutside(rootRef, open, () => setOpen(false))

  useEffect(() => {
    setDirDisplay(audio.recordingDir || 'recordings')
  }, [audio.recordingDir])

  const formatLabel = recordingFormatIdToLabel(
    (audio.recordingFormat ?? 'wav') as RecordingFormatId
  )

  const persistFormat = async (label: RecordingFormatLabel): Promise<void> => {
    const id = recordingFormatLabelToId(label)
    setAudio({ recordingFormat: id })
    try {
      await window.whisperApi?.setAppConfig?.({ recording_format: label })
    } catch {
      /* ignore */
    }
  }

  const browseDir = async (): Promise<void> => {
    try {
      const picked = await window.whisperApi?.pickRecordingDir?.()
      if (!picked) return
      setDirDisplay(picked)
      setAudio({ recordingDir: picked })
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      ref={rootRef}
      className="settings-wrapper relative"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <button
        type="button"
        aria-label="录音设置"
        aria-expanded={open}
        title={`录音设置${syncOn ? '（同步录音已启用）' : ''}`}
        className={`flex h-8 w-8 items-center justify-center rounded border transition ${
          syncOn
            ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
            : 'border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)]'
        }`}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-sm leading-none" aria-hidden>
          ⏺
        </span>
      </button>

      {open && (
        <div
          className="settings-panel absolute right-0 z-50 w-72 rounded border border-[var(--border)] bg-[var(--bg-panel)] p-3 shadow-xl"
          style={
            {
              WebkitAppRegion: 'no-drag',
              top: '100%'
            } as React.CSSProperties
          }
          onMouseDown={(e) => e.stopPropagation()}
        >
          <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
            录音设置
          </p>

          <div className="flex flex-col gap-2.5">
            <label className="flex cursor-pointer items-center justify-between gap-2 rounded border border-[var(--border)] px-2.5 py-2">
              <span className="flex min-w-0 flex-col">
                <span className="text-xs font-medium text-[var(--text)]">
                  同步录音
                </span>
                <span className="mt-0.5 text-[10px] leading-snug text-[var(--text-muted)]">
                  开始听写时同步落盘录音，与会话日志按时间戳配对
                </span>
              </span>
              <input
                type="checkbox"
                className="accent-[var(--accent)]"
                checked={syncOn}
                onChange={(e) => {
                  const enabled = e.target.checked
                  if (onSyncRecordingChange) onSyncRecordingChange(enabled)
                  else setAudio({ syncRecording: enabled })
                }}
              />
            </label>

            <div className="flex flex-col gap-1">
              <span className="text-[10px] text-[var(--text-muted)]">
                录音目录
              </span>
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  readOnly
                  value={dirDisplay}
                  title={dirDisplay}
                  className="min-w-0 flex-1 truncate rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-[11px] text-[var(--text)]"
                />
                <button
                  type="button"
                  className="shrink-0 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-[11px] text-[var(--text)] hover:border-[var(--accent)]"
                  onClick={() => void browseDir()}
                >
                  浏览
                </button>
              </div>
            </div>

            <label className="flex flex-col gap-1 text-[10px] text-[var(--text-muted)]">
              录音格式
              <select
                className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-[11px] text-[var(--text)]"
                value={formatLabel}
                disabled={recordingBusy}
                title={
                  recordingBusy
                    ? '录音进行中不可改格式'
                    : '结束后由 ffmpeg 转码（.wav 无需 ffmpeg）'
                }
                onChange={(e) =>
                  void persistFormat(e.target.value as RecordingFormatLabel)
                }
              >
                {RECORDING_FORMAT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.label}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      )}
    </div>
  )
}
