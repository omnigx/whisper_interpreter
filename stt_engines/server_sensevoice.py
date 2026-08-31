import asyncio
import websockets
import numpy as np
import re
import sys
import time

print("--- 启动 SenseVoice 稳定版 STT 服务 ---")
try:
    from funasr import AutoModel
    import torch
except ImportError as e:
    print(f"❌ 导入失败，请检查环境: {e}")
    sys.exit(1)

# 自动分配硬件
compute_device = "cuda:0" if torch.cuda.is_available() else "cpu"
print(f"-> 策略：使用 {compute_device} 进行运算")

try:
    model = AutoModel(
        model="iic/SenseVoiceSmall", 
        trust_remote_code=True, 
        device=compute_device, 
        disable_update=True
    )
    print(f"✅ SenseVoice 模型加载彻底完成！")
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
                print(f"📥 收到音频包 {len(message)} bytes", flush=True)
                audio_data = np.frombuffer(message, dtype=np.int16).astype(np.float32) / 32768.0
                
                # 如果音频太短（少于0.5秒），忽略以防杂音报错
                if len(audio_data) < 16000 * 0.5:
                    print(f"⏭️ 音频过短 ({len(audio_data)/16000:.2f}s)，跳过", flush=True)
                    continue

                res = model.generate(input=audio_data, language="auto", use_itn=True)
                if res and len(res) > 0:
                    raw_text = res[0]['text']
                    clean_result = clean_text(raw_text)
                    if clean_result:
                        # SenseVoice 直接返回纯文本结果
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