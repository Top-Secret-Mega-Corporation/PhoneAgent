import os
import json
import asyncio
import websockets
from dotenv import load_dotenv

load_dotenv()

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")
ELEVENLABS_AGENT_ID = os.getenv("ELEVENLABS_AGENT_ID", "agent_8101kj0w0x2bfywt0ewvxypb4kqp")  # Default: Spark

CONVAI_WS_URL = "wss://api.elevenlabs.io/v1/convai/conversation"


class ElevenLabsService:
    """
    Bridges a Twilio media stream WebSocket <-> ElevenLabs Conversational AI Agent.

    Audio flow:
      Twilio (mulaw 8000Hz) -> ElevenLabs Agent -> Twilio (mulaw 8000Hz)

    The ElevenLabs ConvAI WS accepts audio in the same mulaw_8000 format
    Twilio uses, so no audio transcoding is needed.
    """

    def __init__(self, agent_id: str = None):
        self.agent_id = agent_id or ELEVENLABS_AGENT_ID
        self._ws = None
        self._audio_callback = None  # Called with (base64_audio_str) when agent speaks
        self._status_callback = None  # Called with (status_dict) on status events
        self._receive_task = None

    async def start_session(self, audio_callback, status_callback=None):
        """
        Opens the ElevenLabs ConvAI WebSocket and begins the session.
        'audio_callback' is an async fn(base64_audio: str) called with agent audio chunks.
        'status_callback' is an async fn(event: dict) for status/transcript events.
        """
        self._audio_callback = audio_callback
        self._status_callback = status_callback

        url = f"{CONVAI_WS_URL}?agent_id={self.agent_id}"

        headers = {
            "xi-api-key": ELEVENLABS_API_KEY
        }

        try:
            self._ws = await websockets.connect(url, additional_headers=headers)
            print(f"[ElevenLabs] Connected to agent {self.agent_id}")

            # Send conversation initiation config:
            # Tell ElevenLabs to output mulaw_8000 (same as Twilio uses)
            init_msg = {
                "type": "conversation_initiation_client_data",
                "conversation_config_override": {
                    "agent": {},
                    "tts": {
                        "output_format": "ulaw_8000"
                    }
                }
            }
            await self._ws.send(json.dumps(init_msg))

            # Start background receive loop
            self._receive_task = asyncio.create_task(self._receive_loop())
        except Exception as e:
            print(f"[ElevenLabs] Failed to connect: {e}")
            raise

    async def _receive_loop(self):
        """Listens for messages from ElevenLabs agent and dispatches callbacks."""
        try:
            async for raw_message in self._ws:
                try:
                    msg = json.loads(raw_message)
                    msg_type = msg.get("type")

                    if msg_type == "audio":
                        # Agent is speaking — forward audio to Twilio
                        audio_event = msg.get("audio_event", {})
                        b64_audio = audio_event.get("audio_base_64")
                        if b64_audio and self._audio_callback:
                            await self._audio_callback(b64_audio)

                    elif msg_type == "agent_response":
                        # Agent generated a text response (transcript)
                        agent_response = msg.get("agent_response_event", {})
                        text = agent_response.get("agent_response", "")
                        if text and self._status_callback:
                            await self._status_callback({
                                "type": "transcript",
                                "sender": "bot",
                                "text": text
                            })

                    elif msg_type == "user_transcript":
                        # Caller's speech was transcribed
                        transcript = msg.get("user_transcription_event", {})
                        text = transcript.get("user_transcript", "")
                        if text and self._status_callback:
                            await self._status_callback({
                                "type": "transcript",
                                "sender": "caller",
                                "text": text
                            })

                    elif msg_type == "interruption":
                        # Agent was interrupted
                        if self._status_callback:
                            await self._status_callback({"type": "status", "status": "interrupted"})

                    elif msg_type == "ping":
                        # Respond to keepalive pings
                        pong = {"type": "pong", "event_id": msg.get("ping_event", {}).get("event_id")}
                        await self._ws.send(json.dumps(pong))

                except json.JSONDecodeError:
                    pass
                except Exception as e:
                    print(f"[ElevenLabs] Error handling message: {e}")

        except websockets.exceptions.ConnectionClosed as e:
            print(f"[ElevenLabs] Connection closed: {e}")
        except Exception as e:
            print(f"[ElevenLabs] Receive loop error: {e}")

    async def send_audio(self, base64_audio: str):
        """
        Forward a chunk of Twilio mulaw_8000 audio (base64) to the ElevenLabs agent.
        """
        if self._ws and self._ws.open:
            msg = {
                "user_audio_chunk": base64_audio
            }
            try:
                await self._ws.send(json.dumps(msg))
            except Exception as e:
                print(f"[ElevenLabs] Error sending audio: {e}")

    async def inject_text(self, text: str):
        """
        Inject text directly into the agent conversation.
        Used when the user types in 'Direct TTS' mode to make the agent speak it.
        """
        if self._ws and self._ws.open:
            msg = {
                "type": "user_message",
                "user_message_event": {
                    "user_message": text
                }
            }
            try:
                await self._ws.send(json.dumps(msg))
            except Exception as e:
                print(f"[ElevenLabs] Error injecting text: {e}")

    async def end_session(self):
        """Close the ElevenLabs agent session."""
        if self._receive_task:
            self._receive_task.cancel()
        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass
        self._ws = None
        print("[ElevenLabs] Session ended")
