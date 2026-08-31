# STT Engines（本地后端引擎目录）

本目录存放 Whisper Interpreter 使用的三个本地 STT WebSocket 后端。
Electron 主进程会在需要时自动拉起对应引擎（见下方"自动启动"）。

| 引擎 | 脚本 | 端口 | 说明 |
|------|------|------|------|
| SenseVoice（默认） | `server_sensevoice.py` | `ws://127.0.0.1:8765` | 整句模式，抗噪稳定 |
| Paraformer | `server_stream.py` | `ws://127.0.0.1:8766` | 流式 partial/final |
| Faster-Whisper | `server_faster_whisper.py` | `ws://127.0.0.1:8767` | medium / large-v3 热切换 |

## 运行环境要求

- Python 环境需包含 `funasr`、`torch`、`websockets`、`faster-whisper` 等依赖。
  默认按 conda 环境 `stt-server` 解析（Miniconda 常见安装路径会自动探测）。
- 可用环境变量 `STT_SERVER_PYTHON` 指定解释器绝对路径覆盖自动探测，
  例如 `C:\ProgramData\Miniconda3\envs\stt-server\python.exe`。
- SenseVoice / Paraformer / FW-medium 的模型走 HuggingFace 本地缓存；
  FW large-v3 需要 `models/faster-whisper-large-v3` 目录——解析顺序：
  1. 环境变量 `STT_MODELS_DIR`（启动器自动注入）
  2. `./models`（本目录内）
  3. `../python_dir/models`（旧位置回退）

## 自动启动逻辑（Electron 主进程 `src/main/sttLauncher.ts`）

- 应用启动时：渲染进程恢复配置后，自动拉起**当前默认引擎**（预热，模型加载需要
  10–40 秒，越早启动越好）。已有实例在端口上时直接复用，不会重复拉起。
- 点击"开始听写"前：若引擎端口未开会自动 spawn 并等待就绪（最长 60s）。
- 切换 STT 引擎后再次开始听写：自动拉起新引擎，并停掉**由本工具拉起的**其他
  引擎（6GB 显存只够常驻一个模型）；用户手动启动的实例不会被触碰。
- 应用退出时：仅终止由本工具拉起的引擎进程；用户手动启动的实例不受影响。

## 手动启动

也可以用 `../python_dir` 里的 `1_sensevoice.bat` / `2_paraformer.bat` /
`3_faster_whisper.bat` 手动启动（效果等价，启动器会复用）。
