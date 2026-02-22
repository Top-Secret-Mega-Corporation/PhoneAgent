import asyncio
import os
import websockets
from dotenv import load_dotenv

load_dotenv()

async def test_stt():
    API_KEY = os.getenv("ELEVENLABS_API_KEY")
    # Let's test different query params for VAD
    uri = "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=ulaw_8000&language_code=en&vad_commit_strategy=true&enable_vad_commit_strategy=true&commit_strategy=vad"
    try:
        async with websockets.connect(uri, additional_headers={"xi-api-key": API_KEY}) as ws:
            print("Connected!")
            resp1 = await ws.recv()
            print("Server Init:", resp1)
    except Exception as e:
        print("Error:", e)

asyncio.run(test_stt())
