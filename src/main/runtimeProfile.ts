import { execFile } from 'node:child_process'
import os from 'node:os'

/**
 * Runtime profile — the single place where hardware differences live.
 *
 * A profile is ONLY (a) a label, (b) extra env injected into engine spawns,
 * and (c) a detection rule. UI, pipeline, logging and guards stay
 * profile-agnostic; adding hardware = adding a profile entry here.
 *
 *  cpu   — everything on CPU (fallback; Zen5 handles SenseVoice small)
 *  igpu  — STT via GPU tensor backend (CUDA on NVIDIA / DirectML on AMD;
 *          engine script falls back to CPU transparently if the backend
 *          is missing in the env). LLM side is Ollama's own business —
 *          on AMD iGPU machines recent Ollama builds use the GPU natively.
 *  npu   — experimental: reserved for NPU (XDNA) paths — VAD/small models
 *          via Ryzen AI / ONNX EP. Enable explicitly via env.
 */

export type RuntimeProfileId = 'cpu' | 'igpu' | 'npu'

export interface RuntimeProfile {
  id: RuntimeProfileId
  label: string
  /** Env merged into every STT engine spawn */
  env: Record<string, string>
  /** STT tensor device hint consumed by server_*.py (STT_DEVICE) */
  sttDevice: 'auto' | 'cpu' | 'dml'
  notes: string
}

export const RUNTIME_PROFILES: Record<RuntimeProfileId, RuntimeProfile> = {
  cpu: {
    id: 'cpu',
    label: 'CPU',
    env: { STT_DEVICE: 'cpu' },
    sttDevice: 'cpu',
    notes: '纯 CPU：无加速器或加速后端不可用时的兜底'
  },
  igpu: {
    id: 'igpu',
    label: 'iGPU / GPU',
    env: { STT_DEVICE: 'auto' },
    sttDevice: 'auto',
    notes: 'GPU 张量后端：NVIDIA→CUDA 自动；AMD→DirectML（需环境内有 torch-directml，缺失则回退 CPU）'
  },
  npu: {
    id: 'npu',
    label: 'NPU（实验）',
    env: { STT_DEVICE: 'auto', WHISPER_NPU: '1' },
    sttDevice: 'auto',
    notes: 'NPU 路线预留（Ryzer AI / ONNX EP，VAD 甜点）；需显式开启'
  }
}

let cachedProfile: { id: RuntimeProfileId; gpuName: string | null } | null = null

/** Query the primary GPU vendor once (PowerShell, 2s cap, cached). */
function queryGpuName(): Promise<string | null> {
  return new Promise((resolve) => {
    const cmd = [
      '-NoProfile',
      '-Command',
      '(Get-CimInstance Win32_VideoController | Where-Object {$_.Name -notmatch "Basic|Virtual"} | Select-Object -First 1).Name'
    ]
    execFile('powershell.exe', cmd, { timeout: 2000, windowsHide: true }, (err, stdout) => {
      const name = err ? null : stdout.trim() || null
      resolve(name && name.length > 0 ? name : null)
    })
  })
}

/**
 * Resolve the active profile: env override first, then GPU presence.
 * Deliberately cheap — the heavy backend decision (CUDA vs DirectML vs
 * CPU) happens INSIDE the engine script where torch knows the truth.
 */
export async function detectRuntimeProfile(): Promise<{
  profile: RuntimeProfile
  gpuName: string | null
}> {
  if (cachedProfile) {
    return { profile: RUNTIME_PROFILES[cachedProfile.id], gpuName: cachedProfile.gpuName }
  }
  const override = process.env['WHISPER_RUNTIME_PROFILE']
  let id: RuntimeProfileId
  let gpuName: string | null = null
  if (override === 'cpu' || override === 'igpu' || override === 'npu') {
    id = override
    gpuName = await queryGpuName()
  } else {
    gpuName = await queryGpuName()
    id = gpuName ? 'igpu' : 'cpu'
  }
  cachedProfile = { id, gpuName }
  return { profile: RUNTIME_PROFILES[id], gpuName }
}

export function runtimeProfileSummary(id: RuntimeProfileId, gpuName: string | null): string {
  const p = RUNTIME_PROFILES[id]
  return gpuName ? `${p.label} · ${gpuName}` : p.label
}

export function profileEnvHome(): string {
  // informational only; conda env root stays resolved by sttLauncher
  return os.homedir()
}
