import os
import json
import asyncio
import logging
import websockets
from dotenv import load_dotenv

load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("ElevenLabsService")

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")
DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"

if not ELEVENLABS_API_KEY:
    logger.warning("ELEVENLABS_API_KEY is not set — requests will likely fail")


class ElevenLabsService:
    def __init__(self, voice_id: str = DEFAULT_VOICE_ID):
        self.voice_id = voice_id
        logger.debug("ElevenLabsService initialized with voice_id=%s", voice_id)

    async def tts_stream_generator(self, text_iterator, output_queue: asyncio.Queue):
        """
        Connects to ElevenLabs TTS WebSocket, sends text from `text_iterator`,
        and puts returned audio chunks (base64 ulaw) into `output_queue`.
        """
        uri = (
            f"wss://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}/stream-input"
            f"?model_id=eleven_turbo_v2&output_format=ulaw_8000"
        )
        logger.debug("TTS connecting to: %s", uri)

        try:
            async with websockets.connect(
                uri,
                 additional_headers={"xi-api-key": ELEVENLABS_API_KEY}
            ) as websocket:
                logger.info("TTS WebSocket connected")

                await websocket.send(json.dumps({
                    "text": " ",
                    "voice_settings": {"stability": 0.5, "similarity_boost": 0.8}
                }))
                logger.debug("TTS init message sent")

                async def send_text():
                    chunk_count = 0
                    async for text_chunk in text_iterator:
                        chunk_count += 1
                        logger.debug("TTS sending text chunk #%d: %r", chunk_count, text_chunk)
                        await websocket.send(json.dumps({"text": text_chunk + " "}))
                        await asyncio.sleep(0.01)
                    logger.debug("TTS text iterator exhausted after %d chunks — sending end signal", chunk_count)
                    await websocket.send(json.dumps({"text": ""}))

                async def receive_audio():
                    audio_chunks_received = 0
                    while True:
                        try:
                            response = await websocket.recv()
                            data = json.loads(response)

                            if data.get("audio"):
                                audio_chunks_received += 1
                                audio_len = len(data["audio"])
                                logger.debug("TTS received audio chunk #%d (base64 len=%d)", audio_chunks_received, audio_len)
                                await output_queue.put(data["audio"])

                            if data.get("isFinal"):
                                logger.info("TTS stream complete — total audio chunks: %d", audio_chunks_received)
                                await output_queue.put(None)
                                break

                            # Log any unexpected fields for visibility
                            unexpected = {k: v for k, v in data.items() if k not in ("audio", "isFinal", "normalizedAlignment", "alignment")}
                            if unexpected:
                                logger.debug("TTS unexpected response fields: %s", unexpected)

                        except websockets.exceptions.ConnectionClosed as e:
                            logger.warning("TTS WebSocket closed unexpectedly: %s", e)
                            await output_queue.put(None)
                            break

                await asyncio.gather(send_text(), receive_audio())

        except Exception as e:
            logger.exception("TTS WebSocket error: %s", e)
            await output_queue.put(None)

    async def stt_stream_analyzer(self, input_queue: asyncio.Queue, callback):
        # Native VAD commits enforce a 1.5s minimum delay, so we revert to our 1.0s artificial slicing
        uri = "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=ulaw_8000&language_code=en"
        logger.debug("STT connecting to: %s", uri)

        try:
            async with websockets.connect(
                uri,
                additional_headers={"xi-api-key": ELEVENLABS_API_KEY}
            ) as websocket:
                logger.info("STT WebSocket connected")

                async def send_audio():
                    chunks_sent = 0
                    try:
                        while True:
                            audio_chunk = await input_queue.get()
                            if audio_chunk is None:
                                logger.debug("STT sentinel after %d chunks — done sending", chunks_sent)
                                break
                            chunks_sent += 1
                            logger.debug("STT sending chunk #%d (base64 len=%d)", chunks_sent, len(audio_chunk))
                            await websocket.send(json.dumps({
                                "message_type": "input_audio_chunk",
                                "audio_base_64": audio_chunk,
                            }))
                    except asyncio.CancelledError:
                        logger.warning("STT send_audio cancelled")

                async def receive_transcripts():
                    transcript_count = 0
                    auto_commit_task: asyncio.Task | None = None
                    
                    state = {
                        "emitted_final_len": 0,
                        "last_raw_text": ""
                    }
                    
                    import re
                    
                    async def commit_after_timeout(text_to_commit: str, raw_len: int):
                        try:
                            # Smart timeout: 1.0s if sentence ended with punctuation, else 2.5s mid-sentence pause
                            has_end_punct = bool(re.search(r'[.!?]\s*$', text_to_commit))
                            timeout = 1.0 if has_end_punct else 2.5
                            
                            await asyncio.sleep(timeout)
                            if text_to_commit:
                                logger.info("STT [AUTO-COMMIT due to silence]: %r", text_to_commit)
                                await callback(text_to_commit, True)
                                state["emitted_final_len"] = raw_len
                        except asyncio.CancelledError:
                            pass

                    try:
                        while True:
                            response = await websocket.recv()
                            data = json.loads(response)
                            event_type = data.get("message_type")
                            logger.debug("STT event: %s", event_type)

                            if event_type == "session_started":
                                logger.info("STT session started: %s", data.get("config"))

                            elif event_type == "partial_transcript":
                                raw_text = data.get("text", "").lstrip()
                                
                                if raw_text == state["last_raw_text"]:
                                    continue
                                state["last_raw_text"] = raw_text
                                
                                slice_idx = min(state["emitted_final_len"], len(raw_text))
                                new_text = raw_text[slice_idx:].strip()

                                # Only process if it contains alphanumerics (ignores stray punctuation updates)
                                if not re.search(r'[a-zA-Z0-9]', new_text):
                                    continue

                                transcript_count += 1
                                logger.info("STT #%d [interim]: %r", transcript_count, new_text)
                                await callback(new_text, False)
                                
                                if auto_commit_task is not None:
                                    auto_commit_task.cancel()
                                auto_commit_task = asyncio.create_task(
                                    commit_after_timeout(new_text, len(raw_text))
                                )

                            elif event_type == "committed_transcript":
                                raw_text = data.get("text", "").lstrip()
                                
                                if auto_commit_task is not None:
                                    auto_commit_task.cancel()
                                    
                                slice_idx = min(state["emitted_final_len"], len(raw_text))
                                new_text = raw_text[slice_idx:].strip()

                                # Even if there's no alphanumerics, a real commit is a commit, but 
                                # let's protect against empty commas sending to LLM.
                                if re.search(r'[a-zA-Z0-9]', new_text):
                                    transcript_count += 1
                                    logger.info("STT #%d [FINAL]: %r", transcript_count, new_text)
                                    await callback(new_text, True)
                                
                                # Reset for next utterance stream
                                state["emitted_final_len"] = 0
                                state["last_raw_text"] = ""

                            elif event_type == "error":
                                logger.error("STT error from server: %s", data)

                            else:
                                logger.debug("STT unhandled event: %s — %s", event_type, data)

                    except websockets.exceptions.ConnectionClosed as e:
                        logger.warning("STT WebSocket closed: %s", e)
                    finally:
                        if auto_commit_task is not None:
                            auto_commit_task.cancel()

                await asyncio.gather(send_audio(), receive_transcripts())

        except asyncio.CancelledError:
            logger.info("STT stream analyzer cancelled")
        except Exception as e:
            logger.exception("STT WebSocket error: %s", e)