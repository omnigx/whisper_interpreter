import asyncio
import websockets
import json
import numpy as np
import sys
from funasr import AutoModel

print("--- 启动 Paraformer 流式 STT 服务 (增量拼接修复版) ---")
print("1. 正在加载本地流式模型...")

try:
    model = AutoModel(model="iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online")
    print("✅ Paraformer 流式模型加载成功！")
except Exception as e:
    print(f"❌ 模型加载失败: {e}")
    sys.exit(1)

chunk_size = [0, 10, 5]

async def handle_audio(websocket):
    print("🟢 客户端已连接，开启新的流式会话")
    cache = {} 
    
    # 【核心修复】：增加当前句子的累加器
    current_sentence = ""  
    
    try:
        async for message in websocket:
            # 1. 收到前端的断句/结算信号
            if isinstance(message, str):
                if message == "is_final":
                    # 强行输入一段空音频，压榨出模型脑子里最后剩下的字，并加上标点
                    res = model.generate(input=np.zeros(1600, dtype=np.float32), cache=cache, is_final=True, chunk_size=chunk_size)
                    
                    if res and len(res) > 0 and 'text' in res[0]:
                        current_sentence += res[0]['text'] # 把最后生成的字和标点也拼上去
                    
                    final_text = current_sentence.strip()
                    
                    # 只有当确实有文字时才发送 final，避免空句子发给翻译模型
                    if final_text:
                        print(f"✅ 结算单句: 『{final_text}』")
                        await websocket.send(json.dumps({
                            "type": "final",
                            "text": final_text
                        }))
                    
                    # 结算完毕，彻底清空状态，准备听下一句
                    cache = {} 
                    current_sentence = ""
                continue

            # 2. 收到前端不断发来的音频切片
            if isinstance(message, bytes):
                audio_data = np.frombuffer(message, dtype=np.int16).astype(np.float32) / 32768.0
                res = model.generate(input=audio_data, cache=cache, is_final=False, chunk_size=chunk_size)
                
                if res and len(res) > 0 and 'text' in res[0]:
                    new_text = res[0]['text']
                    if new_text:
                        # 【关键】把新听出来的碎片，累加到当前的句子里
                        current_sentence += new_text  
                        
                        # 把拼好的、正在生长的完整半句发给前端
                        await websocket.send(json.dumps({
                            "type": "partial",
                            "text": current_sentence 
                        }))
                        
    except websockets.exceptions.ConnectionClosed:
        print("🔴 客户端已断开")
    except Exception as e:
        print(f"❌ 识别过程中发生错误: {e}")

async def main():
    # 绑定 127.0.0.1，避免 Windows 上 localhost→::1 导致前端连不上
    async with websockets.serve(handle_audio, "127.0.0.1", 8766):
        print("🚀 Paraformer 流式服务端已就绪，正在监听: ws://127.0.0.1:8766")
        print("   启动文件: server_stream.py")
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n🛑 服务已手动停止")