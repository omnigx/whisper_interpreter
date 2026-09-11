import { app, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Local STT backend launcher.
 *
 * Engines live in <project>/stt_engines (fallback: sibling ../python_dir) and
 * run in the conda env `stt-server`. The launcher:
 *  - probes the engine's WebSocket port first — a manually started instance
 *    (e.g. via the .bat files) is reused, never double-spawned;
 *  - spawns `python -u <script>` hidden, piping output to logs/stt_launcher.log;
 *  - waits until the port accepts connections (model load: 10–40 s);
 *  - kills only the processes IT spawned when the app quits (Windows children
 *    outlive their parent, which would leak VRAM otherwise).
 */

interface EngineSpec {
  script: string
  port: number
  label: string
}

const ENGINES: Record<string, EngineSpec> = {
  'local-sensevoice': { script: 'server_sensevoice.py', port: 8765, label: 'SenseVoice' },
  'local-paraformer': { script: 'server_stream.py', port: 8766, label: 'Paraformer' },
  'faster-whisper': { script: 'server_faster_whisper.py', port: 8767, label: 'Faster-Whisper' }
}

export interface EnsureEngineResult {
  ok: boolean
  alreadyRunning?: boolean
  waitedMs?: number
  error?: string
}

function projectRoot(): string {
  if (!app.isPackaged) return process.cwd()
  return app.getPath('userData')
}

/** Prefer <root>/stt_engines; packaged builds ship it under resources/. */
function resolveEngineRoot(): string {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'stt_engines')
    if (fs.existsSync(path.join(bundled, 'server_sensevoice.py'))) return bundled
  }
  const preferred = path.join(projectRoot(), 'stt_engines')
  if (fs.existsSync(path.join(preferred, 'server_sensevoice.py'))) return preferred
  const legacy = path.resolve(projectRoot(), '..', 'python_dir')
  if (fs.existsSync(path.join(legacy, 'server_sensevoice.py'))) return legacy
  return preferred
}

function resolveModelsDir(engineRoot: string): string | undefined {
  // STT_MODELS_DIR lets a portable install point at the faster-whisper
  // large-v3 folder without moving model files next to the exe.
  const candidates = [
    process.env['STT_MODELS_DIR'],
    path.join(engineRoot, 'models'),
    path.resolve(engineRoot, '..', 'python_dir', 'models')
  ].filter((p): p is string => Boolean(p))
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return undefined
}

/** Locate the stt-server conda env python (overridable via STT_SERVER_PYTHON). */
function resolvePython(): string | null {
  const override = process.env['STT_SERVER_PYTHON']
  if (override && fs.existsSync(override)) return override

  const roots = [
    process.env['ProgramData'] ? path.join(process.env['ProgramData'], 'Miniconda3') : null,
    process.env['USERPROFILE'] ? path.join(process.env['USERPROFILE'], 'Miniconda3') : null,
    process.env['USERPROFILE'] ? path.join(process.env['USERPROFILE'], 'miniconda3') : null,
    process.env['ProgramData'] ? path.join(process.env['ProgramData'], 'Anaconda3') : null,
    process.env['USERPROFILE'] ? path.join(process.env['USERPROFILE'], 'Anaconda3') : null
  ].filter((p): p is string => Boolean(p))

  for (const root of roots) {
    const exe = path.join(root, 'envs', 'stt-server', 'python.exe')
    if (fs.existsSync(exe)) return exe
  }
  return null
}

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(600, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

const children = new Map<string, ChildProcess>()
const pending = new Map<string, Promise<EnsureEngineResult>>()
let logStream: fs.WriteStream | null = null

function launcherLogPath(): string {
  return path.join(projectRoot(), 'logs', 'stt_launcher.log')
}

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`
  console.log(`[stt-launcher] ${message}`)
  try {
    if (!logStream) {
      fs.mkdirSync(path.dirname(launcherLogPath()), { recursive: true })
      logStream = fs.createWriteStream(launcherLogPath(), { flags: 'a' })
    }
    logStream.write(line)
  } catch {
    /* logging must never break launching */
  }
}

/** Stream chunks → timestamped log lines (tolerates partial UTF-8 chunks). */
function pipeToLog(child: ChildProcess, label: string): void {
  const attach = (stream: NodeJS.ReadableStream | null, prefix: string): void => {
    if (!stream) return
    let buffer = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      buffer += chunk
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '')
        buffer = buffer.slice(idx + 1)
        if (line.trim()) log(`${prefix} ${line}`)
      }
    })
  }
  attach(child.stdout, `${label} ▸`)
  attach(child.stderr, `${label} ▹`)
}

async function ensureEngine(
  engineKey: string,
  timeoutMs = 60000
): Promise<EnsureEngineResult> {
  const spec = ENGINES[engineKey]
  if (!spec) return { ok: false, error: `未知引擎: ${engineKey}` }

  const inflight = pending.get(engineKey)
  if (inflight) return inflight

  const task = (async (): Promise<EnsureEngineResult> => {
    // Already up (user-started bat or warm-started)? Reuse it.
    if (await probePort(spec.port)) {
      log(`${spec.label}: port ${spec.port} already serving — reuse`)
      return { ok: true, alreadyRunning: true, waitedMs: 0 }
    }

    const python = resolvePython()
    if (!python) {
      return {
        ok: false,
        error: '未找到 stt-server Python 环境（可设置环境变量 STT_SERVER_PYTHON 指定 python.exe）'
      }
    }

    const engineRoot = resolveEngineRoot()
    const scriptPath = path.join(engineRoot, spec.script)
    if (!fs.existsSync(scriptPath)) {
      return { ok: false, error: `未找到引擎脚本 ${scriptPath}` }
    }
    const modelsDir = resolveModelsDir(engineRoot)

    log(`${spec.label}: spawning ${python} -u ${spec.script}` + (modelsDir ? ` (models=${modelsDir})` : ''))

    const startedAt = Date.now()
    let exited = false
    const child = spawn(python, ['-u', spec.script], {
      cwd: engineRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        // faster-whisper large-v3 resolves its model folder from this
        ...(modelsDir ? { STT_MODELS_DIR: modelsDir } : {})
      }
    })
    children.set(engineKey, child)
    pipeToLog(child, spec.label)
    child.once('exit', (code) => {
      exited = true
      children.delete(engineKey)
      log(`${spec.label}: process exited (code=${code})`)
    })
    child.once('error', (e) => {
      exited = true
      children.delete(engineKey)
      log(`${spec.label}: spawn error — ${e.message}`)
    })

    // Poll until the WebSocket port accepts connections (model loading)
    const deadline = Date.now() + Math.max(5000, timeoutMs)
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
      if (exited) {
        return { ok: false, error: '引擎进程异常退出（详见 logs/stt_launcher.log）' }
      }
      if (await probePort(spec.port)) {
        const waitedMs = Date.now() - startedAt
        log(`${spec.label}: ready on port ${spec.port} in ${waitedMs}ms`)
        return { ok: true, alreadyRunning: false, waitedMs }
      }
    }
    // Timed out but leave the child running — it may still finish loading
    return { ok: false, waitedMs: Date.now() - startedAt, error: '等待引擎就绪超时（进程仍在启动中）' }
  })()

  pending.set(engineKey, task)
  try {
    return await task
  } finally {
    pending.delete(engineKey)
  }
}

/** Kill only processes we spawned; user-started engines are left alone. */
function killChild(key: string, child: ChildProcess): void {
  if (child.pid == null) return
  log(`killing spawned ${key} (pid ${child.pid})`)
  if (process.platform === 'win32') {
    // /T takes the whole process tree — python may spawn helpers
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
}

/** Stop engines we spawned except `keepKey` — 6 GB VRAM fits one resident model. */
function stopOtherEngines(keepKey: string): void {
  children.forEach((child, key) => {
    if (key !== keepKey) killChild(key, child)
  })
  const keep = children.get(keepKey)
  children.clear()
  if (keep) children.set(keepKey, keep)
}

function killSpawnedEngines(): void {
  children.forEach((child, key) => killChild(key, child))
  children.clear()
}

export function registerSttLauncher(): void {
  ipcMain.handle(
    'stt-launcher:ensure',
    (_event, engineKey: unknown, timeoutMs: unknown) =>
      ensureEngine(
        typeof engineKey === 'string' ? engineKey : '',
        typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : 60000
      )
  )

  /** Port probe only — never spawns. Mirrors what auto-launch would reuse. */
  ipcMain.handle('stt-launcher:status', (_event, engineKey: unknown) => {
    const spec = ENGINES[typeof engineKey === 'string' ? engineKey : '']
    if (!spec) return Promise.resolve({ ok: false, running: false, error: '未知引擎' })
    return probePort(spec.port).then((running) => ({ ok: true, running, port: spec.port }))
  })

  /** Kill only engines this app spawned (user-started .bat instances stay). */
  ipcMain.handle('stt-launcher:stop', () => {
    killSpawnedEngines()
    return { ok: true }
  })

  ipcMain.handle('stt-launcher:stop-others', (_event, keepKey: unknown) => {
    stopOtherEngines(typeof keepKey === 'string' ? keepKey : '')
  })

  app.on('before-quit', () => killSpawnedEngines())
}
