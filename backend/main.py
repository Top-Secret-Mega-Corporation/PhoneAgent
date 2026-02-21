import json
import asyncio
import urllib.request
from datetime import datetime
from fastapi import FastAPI, WebSocket, Request, Response, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from backend.database.mongo import db
from backend.services.twilio_service import generate_twiml, initiate_outbound_call
from backend.services.connection_manager import manager
from backend.services.elevenlabs_service import ElevenLabsService

app = FastAPI(title="AI Voice Surrogate")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Startup / Shutdown ──────────────────────────────────────────────────────

@app.on_event("startup")
async def startup_db_client():
    await db.connect()

@app.on_event("shutdown")
async def shutdown_db_client():
    await db.close()

# ── Helpers ─────────────────────────────────────────────────────────────────

def get_base_url(request: Request):
    """Dynamically resolve ngrok public URL for Twilio webhooks."""
    try:
        req = urllib.request.Request("http://localhost:4040/api/tunnels")
        with urllib.request.urlopen(req, timeout=1) as response:
            data = json.loads(response.read().decode())
            for t in data.get("tunnels", []):
                if t.get("public_url", "").startswith("https://"):
                    return t["public_url"]
    except Exception:
        pass
    host = request.headers.get("host", request.url.hostname)
    return f"https://{host}"

# ── HTTP Routes ──────────────────────────────────────────────────────────────

@app.get("/")
def read_root():
    return {"status": "ok", "message": "PhoneAgent Backend is running!"}

@app.api_route("/twiml", methods=["GET", "POST"])
async def twiml_bot(request: Request):
    base_url = get_base_url(request)
    ws_url = base_url.replace("https://", "wss://").replace("http://", "ws://") + "/media-stream"
    twiml = generate_twiml(ws_url)
    return Response(content=twiml, media_type="text/xml")

class CallRequest(BaseModel):
    to_number: str

@app.post("/call")
async def make_call(call_req: CallRequest, request: Request):
    base_url = get_base_url(request)
    webhook_url = f"{base_url}/twiml"
    try:
        call_sid = initiate_outbound_call(call_req.to_number, webhook_url)
        return {"status": "success", "call_sid": call_sid}
    except Exception as e:
        return Response(content=str(e), status_code=500)

@app.get("/dev-session")
async def get_dev_session():
    """
    Returns a signed ElevenLabs WebSocket URL for browser-direct dev mode.
    The frontend uses this to connect to the agent without exposing the API key.
    """
    import urllib.request as _req
    import os
    api_key = os.getenv("ELEVENLABS_API_KEY")
    agent_id = os.getenv("ELEVENLABS_AGENT_ID", "agent_8101kj0w0x2bfywt0ewvxypb4kqp")
    url = f"https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id={agent_id}"
    try:
        request = _req.Request(url, headers={"xi-api-key": api_key})
        with _req.urlopen(request, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            return {"signed_url": data["signed_url"]}
    except Exception as e:
        return Response(content=f"Failed to get signed URL: {e}", status_code=500)

# ── Active ElevenLabs agent sessions, keyed by stream_sid ────────────────────

active_sessions: dict[str, ElevenLabsService] = {}

# ── Dev Mode WebSocket: browser mic ↔ ElevenLabs agent ───────────────────────

@app.websocket("/dev-stream")
async def dev_stream(websocket: WebSocket):
    """
    Dev Mode audio bridge:
      - Browser sends PCM16 16kHz mic audio as binary frames
      - Browser sends director text as JSON: {"type": "inject", "text": "..."}
      - Agent audio is forwarded back to browser as binary frames (PCM16 16kHz)
      - Transcripts are sent to browser as JSON: {"type": "transcript", "sender": ..., "text": ...}
    """
    await websocket.accept()
    import os
    import websockets as _ws

    api_key = os.getenv("ELEVENLABS_API_KEY")
    agent_id = os.getenv("ELEVENLABS_AGENT_ID", "agent_8101kj0w0x2bfywt0ewvxypb4kqp")
    el_ws_url = f"wss://api.elevenlabs.io/v1/convai/conversation?agent_id={agent_id}"

    try:
        async with _ws.connect(el_ws_url, additional_headers={"xi-api-key": api_key}) as el_ws:
            print("[DevMode] ElevenLabs agent connected")

            # Wait for ElevenLabs initiation metadata
            raw = await el_ws.recv()
            init_meta = json.loads(raw)
            print(f"[DevMode] EL init: {init_meta.get('type')}")

            # Send conversation config: request PCM 16kHz output (browser can play directly)
            await el_ws.send(json.dumps({
                "type": "conversation_initiation_client_data",
                "conversation_config_override": {
                    "agent": {},
                    "tts": { "output_format": "pcm_16000" }
                }
            }))

            # Notify browser that session is ready
            await websocket.send_json({"type": "status", "status": "connected"})

            async def receive_from_browser():
                """Receive mic audio (binary) or inject text (JSON) from browser."""
                try:
                    while True:
                        msg = await websocket.receive()
                        if "bytes" in msg and msg["bytes"]:
                            # Binary = PCM16 mic audio → forward to ElevenLabs
                            import base64 as _b64
                            b64 = _b64.b64encode(msg["bytes"]).decode()
                            await el_ws.send(json.dumps({"user_audio_chunk": b64}))
                        elif "text" in msg and msg["text"]:
                            data = json.loads(msg["text"])
                            if data.get("type") == "inject":
                                # Director text: send as user_message so agent responds to it
                                text = data.get("text", "").strip()
                                if text:
                                    await el_ws.send(json.dumps({
                                        "type": "user_message",
                                        "user_message_event": {"user_message": f"DIRECTOR: {text}"}
                                    }))
                except (WebSocketDisconnect, _ws.exceptions.ConnectionClosed):
                    pass

            async def receive_from_elevenlabs():
                """Receive audio/transcripts from ElevenLabs and forward to browser."""
                try:
                    async for raw_msg in el_ws:
                        msg = json.loads(raw_msg)
                        msg_type = msg.get("type")

                        if msg_type == "audio":
                            # Forward raw PCM16 audio to browser as binary
                            import base64 as _b64
                            b64 = msg.get("audio_event", {}).get("audio_base_64", "")
                            if b64:
                                pcm_bytes = _b64.b64decode(b64)
                                await websocket.send_bytes(pcm_bytes)

                        elif msg_type == "agent_response":
                            text = msg.get("agent_response_event", {}).get("agent_response", "")
                            if text:
                                await websocket.send_json({
                                    "type": "transcript", "sender": "bot", "text": text
                                })

                        elif msg_type == "user_transcript":
                            text = msg.get("user_transcription_event", {}).get("user_transcript", "")
                            if text:
                                await websocket.send_json({
                                    "type": "transcript", "sender": "caller", "text": text
                                })

                        elif msg_type == "interruption":
                            await websocket.send_json({"type": "status", "status": "interrupted"})

                        elif msg_type == "ping":
                            await el_ws.send(json.dumps({
                                "type": "pong",
                                "event_id": msg.get("ping_event", {}).get("event_id")
                            }))

                except (_ws.exceptions.ConnectionClosed, WebSocketDisconnect):
                    pass

            # Run both loops concurrently
            await asyncio.gather(receive_from_browser(), receive_from_elevenlabs())

    except Exception as e:
        print(f"[DevMode] Error: {e}")
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass

# ── UI WebSocket (frontend → backend control channel) ────────────────────────

@app.websocket("/ui-stream")
async def ui_stream(websocket: WebSocket):
    await manager.connect_ui(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            action = msg.get("action")
            text = msg.get("text", "").strip()

            if not text:
                continue

            stream_sid = manager.current_stream_sid
            session = active_sessions.get(stream_sid) if stream_sid else None

            if action == "direct_tts" and session:
                # Inject user text directly into the active agent session.
                # The agent will speak this text in its configured voice.
                print(f"[UI] Injecting text into agent: {text}")
                await session.inject_text(text)
                # Echo to UI transcript
                await manager.broadcast_ui({
                    "type": "transcript",
                    "sender": "caller",
                    "text": f"[You typed]: {text}"
                })

            elif action == "agent_prompt" and session:
                # In agent mode, inject as a user message so the agent responds conversationally
                await session.inject_text(text)
                await manager.broadcast_ui({
                    "type": "transcript",
                    "sender": "caller",
                    "text": f"[Director prompt]: {text}"
                })

            elif action == "standard":
                # Standard mode – caller uses their own voice, no AI processing.
                # Nothing to inject; just acknowledge in the UI transcript.
                await manager.broadcast_ui({
                    "type": "transcript",
                    "sender": "caller",
                    "text": f"[Standard mode]: {text}"
                })

            else:
                await manager.broadcast_ui({
                    "type": "transcript",
                    "sender": "caller",
                    "text": "[No active call to speak on]"
                })

    except WebSocketDisconnect:
        manager.disconnect_ui(websocket)

# ── Twilio Media Stream WebSocket ─────────────────────────────────────────────

@app.websocket("/media-stream")
async def media_stream(websocket: WebSocket):
    """
    Bridges Twilio media stream <-> ElevenLabs Conversational AI Agent.
    
    Audio flow:
      Twilio caller audio (mulaw 8000) → ElevenLabs agent
      ElevenLabs agent response audio (mulaw 8000) → Twilio → caller hears AI
    """
    await websocket.accept()
    stream_sid = None
    el_session: ElevenLabsService = None

    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            event = msg.get("event")

            if event == "connected":
                print("[Twilio] Media stream connected")

            elif event == "start":
                stream_sid = msg["start"]["streamSid"]
                await manager.connect_twilio(websocket, stream_sid)

                # Log call to DB — fire-and-forget, never block the audio path
                async def _log_call_start():
                    try:
                        await db.db["calls"].insert_one({
                            "call_id": stream_sid,
                            "twilio_call_sid": stream_sid,
                            "status": "in_progress",
                            "direction": "outbound",
                            "start_time": datetime.utcnow()
                        })
                    except Exception as db_err:
                        print(f"[DB] Warning: could not log call start: {db_err}")
                asyncio.create_task(_log_call_start())

                # Start ElevenLabs agent session
                el_session = ElevenLabsService()

                async def on_agent_audio(b64_audio: str):
                    """Forward ElevenLabs agent audio to caller via Twilio."""
                    await manager.send_audio_to_twilio(stream_sid, b64_audio)

                async def on_agent_event(event_data: dict):
                    """Forward transcripts/status to the UI dashboard."""
                    await manager.broadcast_ui(event_data)
                    # Persist transcripts to DB — fire-and-forget
                    if event_data.get("type") == "transcript":
                        sid = stream_sid
                        async def _log_transcript():
                            try:
                                await db.db["transcripts"].insert_one({
                                    "call_id": sid,
                                    "sender": event_data.get("sender"),
                                    "text": event_data.get("text"),
                                    "timestamp": datetime.utcnow()
                                })
                            except Exception as db_err:
                                print(f"[DB] Warning: could not log transcript: {db_err}")
                        asyncio.create_task(_log_transcript())

                try:
                    await el_session.start_session(
                        audio_callback=on_agent_audio,
                        status_callback=on_agent_event
                    )
                    active_sessions[stream_sid] = el_session
                    print(f"[ElevenLabs] Agent session started for stream {stream_sid}")
                except Exception as el_err:
                    print(f"[ElevenLabs] ERROR: Failed to start session: {el_err}")
                    await manager.broadcast_ui({"type": "status", "status": "agent_error"})

            elif event == "media":
                # Forward caller's audio to the ElevenLabs agent in real-time
                if el_session:
                    payload = msg["media"]["payload"]
                    await el_session.send_audio(payload)

            elif event == "stop":
                print(f"[Twilio] Stream stopped: {stream_sid}")
                break

    except WebSocketDisconnect:
        print(f"[Twilio] WebSocket disconnected: {stream_sid}")

    finally:
        # Clean up ElevenLabs session
        if el_session:
            await el_session.end_session()
        if stream_sid:
            active_sessions.pop(stream_sid, None)
            manager.disconnect_twilio(stream_sid)
            sid = stream_sid
            async def _log_call_end():
                try:
                    await db.db["calls"].update_one(
                        {"call_id": sid},
                        {"$set": {"status": "completed", "end_time": datetime.utcnow()}}
                    )
                except Exception:
                    pass
            asyncio.create_task(_log_call_end())
