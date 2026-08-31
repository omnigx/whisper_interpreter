import asyncio
import websockets
import numpy as np
import json
import gc
import os
from faster_whisper import WhisperModel

# 屏蔽 Windows 环境下的 Symlink 警告
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

# 映射本地模型路径与在线退路
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def _resolve_models_dir():
    """模型目录解析：环境变量 STT_MODELS_DIR（Electron 启动器注入）→ 脚本同目录 models → 兄弟目录 python_dir/models"""
    env_dir = os.environ.get("STT_MODELS_DIR")
    if env_dir and os.path.isdir(env_dir):
        return env_dir
    local = os.path.join(BASE_DIR, "models")
    if os.path.isdir(local):
        return local
    sibling = os.path.normpath(os.path.join(BASE_DIR, "..", "python_dir", "models"))
    if os.path.isdir(sibling):
        return sibling
    return local

MODELS_DIR = _resolve_models_dir()
MODEL_PATHS = {
    "medium": "medium",  # 若本地未预先下载，可直接拉取 huggingface 命名或指定为本地文件夹
    "large-v3": os.path.join(MODELS_DIR, "faster-whisper-large-v3")
}

# 全局状态变量
current_model_size = "medium"
model = None

def load_model(target_size):
    global model, current_model_size
    
    # 强制释放旧模型及显存空间
    if model is not None:
        print(f"正在从显存中彻底卸载旧模型: {current_model_size}...")
        del model
        gc.collect()
    
    # 获取本地文件夹路径或标准模型标识
    model_path_or_name = MODEL_PATHS.get(target_size, target_size)
    
    # 检测本地路径是否存在
    if target_size == "large-v3" and not os.path.exists(model_path_or_name):
        print(f"[警告] 未在本地找到 large-v3 目录: {model_path_or_name}")
        print("将尝试直接在线连接 Hugging Face 加载（可能会极慢或卡顿）...")
    
    print(f"正在加载 Faster-Whisper [{target_size}] 模型 (int8 显存优化版)...")
    
    # 初始化 CTranslate2 模型（采用 cuda + int8 极致压榨显存）
    model = WhisperModel(model_path_or_name, device="cuda", compute_type="int8")
    current_model_size = target_size
    print(f"==> [{target_size}] 模型热重载/初始化成功，已就绪 <==")

# 服务启动时默认加载 medium 模型
load_model(current_model_size)

async def handle_audio(websocket, *args):
    global current_model_size, model
    print("前端客户端已连接至 Faster-Whisper 引擎")
    
    try:
        async for message in websocket:
            # -------------------------------------------------------------
            # 分支 1：处理来自前端的 JSON 文本控制指令 (如热切换模型)
            # -------------------------------------------------------------
            if isinstance(message, str):
                try:
                    cmd = json.loads(message)
                    if cmd.get("action") == "switch_model":
                        target_model = cmd.get("model")
                        if target_model in ["medium", "large-v3"] and target_model != current_model_size:
                            load_model(target_model)
                            # 切换完成后发回系统消息通知前端
                            await websocket.send(json.dumps({
                                "type": "system", 
                                "message": f"STT引擎已热切换至 {target_model}"
                            }))
                except Exception as e:
                    print(f"控制指令解析失败: {e}")
            
            # -------------------------------------------------------------
            # 分支 2：处理二进制 PCM 音频流，执行转写与标点断句
            # -------------------------------------------------------------
            elif isinstance(message, bytes):
                if model is None:
                    continue
                
                audio_data = np.frombuffer(message, dtype=np.float32)
                
                # 调用 faster-whisper 转写
                segments, info = model.transcribe(
                    audio_data, 
                    beam_size=5,
                    vad_filter=True, # 使用 VAD 过滤无意义噪音和底噪
                    vad_parameters=dict(min_silence_duration_ms=500)
                )
                
                # 标点符号截断器 (Punctuation Accumulator)
                TERMINAL_PUNCTUATION = ('.', '?', '!', '。', '？', '！')
                buffer_text = ""
                
                for segment in segments:
                    text = segment.text.strip()
                    if not text:
                        continue
                    
                    # 格式化单词/短语间距
                    if buffer_text and not buffer_text[-1] in (' ', '。', '？', '！'):
                        buffer_text += " " + text
                    else:
                        buffer_text += text
                    
                    # 一旦匹配到句末标点，立即单独作为一个文本包发送，避免多句连体
                    if buffer_text.endswith(TERMINAL_PUNCTUATION):
                        await websocket.send(buffer_text.strip())
                        print(f"输出单句转写: {buffer_text.strip()}")
                        buffer_text = "" # 清空缓冲区
                
                # 兜底逻辑：处理片段末尾未能带标点的残句
                if buffer_text.strip():
                    await websocket.send(buffer_text.strip())
                    print(f"输出末尾转写: {buffer_text.strip()}")
                    
    except websockets.exceptions.ConnectionClosed:
        print("客户端连接已断开")
    except Exception as e:
        print(f"发生错误: {e}")

async def main():
    print("Faster-Whisper (本地离线优化 + 标点断句版) 服务已在 ws://localhost:8767 启动")
    async with websockets.serve(handle_audio, "localhost", 8767):
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n服务已手动停止")