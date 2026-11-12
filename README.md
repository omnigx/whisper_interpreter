# Whisper Interpreter

A real-time dictation and AI-assisted translation desktop tool built for professional simultaneous interpreters.

## Tech Stack

- Electron + electron-vite + React 19 + TypeScript + Tailwind CSS 4
- Zustand state management
- Pipeline: Mic → Web Audio → Silero-VAD → 16 kHz PCM → WebSocket STT → context reassembly → streaming LLM translation

## Development

```bash
npm install
npm run dev
```

### System dependencies (sync recording)

MP3 / FLAC export requires a local **ffmpeg** installation on `PATH`. Not needed for `.wav`-only export.

Session logs are written to `logs/` (`userData` after packaging); recordings to `recordings/`.

## Roadmap

1. ✅ Dual-window framework (full workspace / frameless always-on-top subtitle) + font scaling
2. ✅ Web Audio capture + Volume / Gain + 16 kHz PCM
3. ✅ Silero-VAD + STT WebSocket (cloud / local / mock) + context reassembly
4. ✅ Unified LLM adapter layer (OpenAI-compatible) + dual-mode engines (all-online / all-offline / hybrid) + streaming translation, terminology, one-click degradation

### Dual-mode engines

| Mode | STT | LLM |
|------|-----|-----|
| All-online | Deepgram / Azure / Aliyun | DeepSeek / Gemini |
| All-offline | SenseVoice / Paraformer / Faster-Whisper | Ollama (Qwen family, etc.) |
| Hybrid | any combination | any combination |

Unified LLM client: switch Base URL / API Key / Model Name only — the streaming UI stays identical. Ollama defaults to `http://localhost:11434/v1`.

### Online-meeting mode (system-audio loopback)

Three input-source options on the control bar; zero configuration and driver-free for meeting software:

| Input source | Use case |
|--------|------|
| Microphone (default) | USB-DAC / line-in — the original mode |
| System audio | Loopback of the system output mix — transcribes **other participants only** (the local mic is not part of the output mix, so your own voice is filtered naturally) |
| System + mic | Both sources mixed — transcribes everyone (including yourself) |

How it works: Electron `setDisplayMediaRequestHandler` + `audio: 'loopback'` passive bypass capture. Speakers keep playing normally; no audio channel is occupied; no conflicts with Zoom / Tencent Meeting / Teams / browser-based meeting tools or their built-in captions. Recordings capture the mix corresponding to the selected input source (a full mixed mono track in hybrid mode). The `input_device` field in SYS session snapshots (`system-loopback` / `system-loopback+mic`) marks the capture environment.

### Local STT servers (`stt_engines/`)

Server scripts live in `stt_engines/`; manual launchers (`1_sensevoice.bat` etc.) are in the sibling `../python_dir/` directory outside this repository.

| Engine | Python entry | WebSocket |
|------|-------------|-----------|
| SenseVoice (default, noise-robust) | `server_sensevoice.py` | `ws://127.0.0.1:8765` |
| Paraformer (fast streaming) | `server_stream.py` | `ws://127.0.0.1:8766` |
| Faster-Whisper large-v3 (multilingual backup) | `server_faster_whisper.py` | `ws://127.0.0.1:8767` |

---

# Whisper Interpreter（中文）

专业同声传译员专用的实时听写与 AI 辅助翻译桌面工具。

## 技术栈

- Electron + electron-vite + React 19 + TypeScript + Tailwind CSS 4
- Zustand 状态管理
- 流水线：Mic → Web Audio → Silero-VAD → 16kHz PCM → WebSocket STT → 上下文重组 → LLM 流式翻译

## 开发

```bash
npm install
npm run dev
```

### 系统依赖（同步录音）

MP3 / FLAC 导出依赖本机已安装的 **ffmpeg**，并加入 `PATH`。仅导出 `.wav` 时不需要 ffmpeg。

会话日志写入项目根目录 `logs/`（打包后为 userData）；录音写入 `recordings/`。

## 分阶段

1. ✅ 双窗口框架（全尺寸 / 无边框字幕置顶）+ 字体缩放
2. ✅ Web Audio 麦克风 + Volume / Gain + 16kHz PCM
3. ✅ Silero-VAD + STT WebSocket（云端 / 本地 / Mock）+ 上下文重组
4. ✅ 统一 LLM 适配层（OpenAI 兼容）+ 双模引擎（全在线/全离线/混合）+ 流式翻译/术语 + 一键降级

### 双模引擎

| 模式 | STT | LLM |
|------|-----|-----|
| 全在线 | Deepgram / Azure / 阿里云 | DeepSeek / Gemini |
| 全离线 | SenseVoice / Paraformer / Faster-Whisper | Ollama（Qwen 系等） |
| 混合 | 任意组合 | 任意组合 |

统一 LLM Client：只需改 Base URL / API Key / Model Name，流式 UI 不变。Ollama 默认 `http://localhost:11434/v1`。

### 线上会议模式（系统声音环回）

控制条「输入源」三选一，会议软件零配置、免驱动：

| 输入源 | 用途 |
|--------|------|
| 麦克风（默认） | USB-DAC / 线路输入，原模式 |
| 系统声音 | 环回采集系统输出混音——只听写会议里**他人**的声音（本机麦克风不在输出混音中，天然过滤自己的声音） |
| 系统+麦克风 | 两路混合，听写所有人（含自己） |

原理：Electron `setDisplayMediaRequestHandler` + `audio: 'loopback'` 被动旁路采集，扬声器正常出声、不占用音频通道、与 Zoom/腾讯会议/Teams/网页端会议软件及它们自带的字幕互不冲突。录制会记录输入源对应的混音（混合模式下为全员混合单声道）。日志 SYS 会话快照中的 `input_device` 字段（`system-loopback` / `system-loopback+mic`）标记素材环境。

### 本地 STT 服务（`stt_engines/`）

服务脚本在本仓库 `stt_engines/`；手动启动脚本（`1_sensevoice.bat` 等）位于仓库外的 `../python_dir/` 目录。

| 引擎 | Python 入口 | WebSocket |
|------|-------------|-----------|
| SenseVoice（默认/抗噪） | `server_sensevoice.py` | `ws://127.0.0.1:8765` |
| Paraformer（极速流式） | `server_stream.py` | `ws://127.0.0.1:8766` |
| Faster-Whisper large-v3（多语备选） | `server_faster_whisper.py` | `ws://127.0.0.1:8767` |
