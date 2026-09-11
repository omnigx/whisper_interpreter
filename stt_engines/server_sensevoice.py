import asyncio
import websockets
import numpy as np
import os
import re
import sys
from pathlib import Path

print("--- 启动 SenseVoice 稳定版 STT 服务 ---")

# 离线启动：funasr 收到 hub id（iic/...）时会向 modelscope 校验远程 revision，
# 断网/弱网时启动被卡住。下面优先把模型解析成本地缓存路径（零网络请求），
# 仅在本地完全找不到缓存时才回退 hub id（此时首次下载本就需要联网）。
# 如需强制刷新模型：删除对应缓存目录，或用 SENSEVOICE_MODEL_DIR 指定新目录。
os.environ.setdefault("HF_HUB_OFFLINE", "1")


def resolve_model_source():
    override = os.environ.get("SENSEVOICE_MODEL_DIR")
    if override and Path(override).exists():
        return override
    base = Path(os.environ.get("MODELSCOPE_CACHE") or Path.home() / ".cache" / "modelscope")
    # 新旧几代 modelscope 缓存布局都认；新版在 snapshots/<rev>/ 下
    roots = [
        base / "models" / "iic--SenseVoiceSmall",
        base / "hub" / "models" / "iic" / "SenseVoiceSmall",
        base / "hub" / "iic" / "SenseVoiceSmall",
        Path(__file__).resolve().parent / "models" / "SenseVoiceSmall",
    ]

    def ready(p: Path) -> bool:
        return (p / "config.yaml").exists() or (p / "config.json").exists()

    for root in roots:
        if ready(root):
            return str(root)
        snap = root / "snapshots"
        if snap.is_dir():
            for rev in sorted(snap.iterdir()):
                if ready(rev):
                    return str(rev)
    print("⚠️ 未找到本地模型缓存，将按 hub id 加载（需要联网）")
    return "iic/SenseVoiceSmall"


try:
    from funasr import AutoModel
    import torch
except ImportError as e:
    print(f"❌ 导入失败，请检查环境: {e}")
    sys.exit(1)

# 自动分配硬件
compute_device = "cuda:0" if torch.cuda.is_available() else "cpu"
print(f"-> 策略：使用 {compute_device} 进行运算")

model_source = resolve_model_source()
print(f"-> 模型来源：{model_source}")

try:
    model = AutoModel(
        model=model_source,
        trust_remote_code=True,
        device=compute_device,
        disable_update=True
    )
    print("✅ SenseVoice 模型加载彻底完成！")
except Exception as e:
    print(f"❌ 模型加载崩溃: {e}")
    sys.exit(1)

def clean_text(text):
    # 清理掉 SenseVoice 偶尔输出的 <|zh|> 这类语言标签
    text = re.sub(r'<\|.*?\|>', '', text)
    return text.strip()

async def handle_audio(websocket):
    print("🟢 前端客户端已连接 (SenseVoice 模式)", flush=True)
    try:
        async for message in websocket:
            # 过滤掉前端可能发来的非二进制心跳包或控制指令
            if isinstance(message, str):
                print(f"⚠️ 忽略文本消息: {message[:80]}", flush=True)
                continue

            if isinstance(message, bytes):
                audio_data = np.frombuffer(message, dtype=np.int16).astype(np.float32) / 32768.0

                # 过短音频丢弃（<0.15s 基本是噪声/残留）。
                # 原 0.5s 门槛会把真实短句（"好的""对"等应答）整个吞掉。
                if len(audio_data) < 16000 * 0.15:
                    continue

                res = model.generate(input=audio_data, language="auto", use_itn=True)
                if res and len(res) > 0:
                    raw_text = res[0]['text']
                    clean_result = clean_text(raw_text)
                    if clean_result:
                        await websocket.send(clean_result)
                        print(f"✅ 识别结果: {clean_result}", flush=True)

    except websockets.exceptions.ConnectionClosed:
        print("🔴 客户端已断开", flush=True)
    except Exception as e:
        print(f"❌ 推理发生错误: {e}", flush=True)

async def main():
    # 绑定 127.0.0.1，避免 Windows 上 localhost→::1 导致前端连不上
    async with websockets.serve(handle_audio, "127.0.0.1", 8765):
        print("🚀 SenseVoice 服务端已就绪，正在监听: ws://127.0.0.1:8765", flush=True)
        print("   启动文件: server_sensevoice.py", flush=True)
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n🛑 服务已停止")
