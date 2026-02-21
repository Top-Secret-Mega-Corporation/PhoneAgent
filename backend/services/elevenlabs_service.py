import os
import json
import base64
import asyncio
import websockets
from dotenv import load_dotenv

load_dotenv()

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")

# Default voice: Rachel
DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"

class ElevenLabsService:
    def __init__(self, voice_id: str = DEFAULT_VOICE_ID):
        self.voice_id = voice_id

    async def tts_stream_generator(self, text_iterator, output_queue: asyncio.Queue):
        """
        Connects to ElevenLabs TTS WebSocket, sends text from `text_iterator`, 
        and puts returned audio chunks (base64 ulaw) into `output_queue`.
        """
        uri = f"wss://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}/stream-input?model_id=eleven_monolingual_v1&output_format=ulaw_8000"
        
        try:
            async with websockets.connect(uri) as websocket:
                # Initialization with first message containing API key
                init_msg = {
                    "text": " ",
                    "voice_settings": {"stability": 0.5, "similarity_boost": 0.8},
                    "xi_api_key": ELEVENLABS_API_KEY,
                }
                await websocket.send(json.dumps(init_msg))

                async def send_text():
                    async for text_chunk in text_iterator:
                        # Append a space to ensure the model groups words naturally
                        msg = {"text": text_chunk + " "}
                        await websocket.send(json.dumps(msg))
                        await asyncio.sleep(0.01)
                    
                    # Empty text message signifies the end of the text stream
                    await websocket.send(json.dumps({"text": ""}))

                async def receive_audio():
                    while True:
                        try:
                            response = await websocket.recv()
                            data = json.loads(response)
                            if data.get("audio"):
                                # Put base64 audio chunk in queue to be sent to Twilio
                                await output_queue.put(data["audio"])
                            if data.get("isFinal"):
                                # Put None to signify end of stream
                                await output_queue.put(None)
                                break
                        except websockets.exceptions.ConnectionClosed:
                            break

                await asyncio.gather(send_text(), receive_audio())
        except Exception as e:
            print(f"ElevenLabs TTS WebSocket error: {e}")
            await output_queue.put(None)

    async def stt_stream_analyzer(self, input_queue: asyncio.Queue, callback):
        """
        Connects to ElevenLabs STT WebSocket to transcribe Twilio streamed audio.
        Yields transcribed text via `callback(text, is_final)`.
        """
        # Note: ElevenLabs Realtime STT requires a dedicated STT WS endpoint. 
        # Using a mock loop below to consume the queue and prevent memory leaks.
        # In a full production env, you would route via wss://api.elevenlabs.io/v1/speech-to-text
        print("STT analysis task started for incoming stream.")
        try:
            while True:
                audio = await input_queue.get()
                if audio is None:
                    break
                
                # Mock sending audio to WS: await ws.send(json.dumps({"user_audio_chunk": audio}))
                # Mock receiving text back from WS:
                # response = await ws.recv()
                # await callback(response.text, response.isFinal)
                
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"STT error: {e}")
