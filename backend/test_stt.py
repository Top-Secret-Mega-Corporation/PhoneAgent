import asyncio
import os
import json
import base64
import websockets
from dotenv import load_dotenv

load_dotenv()

async def test_stt():
    API_KEY = os.getenv("ELEVENLABS_API_KEY")
    uri = "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=ulaw_8000&language_code=en"
    try:
        async with websockets.connect(uri, additional_headers={"xi-api-key": API_KEY}) as ws:
            print("Connected!")
            resp1 = await ws.recv()
            print("Server Init:", resp1)

            dummy_audio = bytes([255] * 8000) 
            b64_audio = base64.b64encode(dummy_audio).decode('utf-8')
            
            await ws.send(json.dumps({
                "message_type": "input_audio_chunk",
                "audio_base_64": b64_audio,
            }))
            # Wait for transcripts Let's receive a few times
            for _ in range(2):
                try:
                    resp = await asyncio.wait_for(ws.recv(), timeout=2.0)
                    print("Received:", resp)
                except asyncio.TimeoutError:
                    print("Timeout getting resp")
                
    except Exception as e:
        print("Error:", e)

asyncio.run(test_stt())
