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

# ── Active ElevenLabs agent sessions, keyed by stream_sid ────────────────────

active_sessions: dict[str, ElevenLabsService] = {}

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

                # Log call to DB
                await db.db["calls"].insert_one({
                    "call_id": stream_sid,
                    "twilio_call_sid": stream_sid,
                    "status": "in_progress",
                    "direction": "outbound",
                    "start_time": datetime.utcnow()
                })

                # Start ElevenLabs agent session
                el_session = ElevenLabsService()

                async def on_agent_audio(b64_audio: str):
                    """Forward ElevenLabs agent audio to caller via Twilio."""
                    await manager.send_audio_to_twilio(stream_sid, b64_audio)

                async def on_agent_event(event_data: dict):
                    """Forward transcripts/status to the UI dashboard."""
                    await manager.broadcast_ui(event_data)
                    # Persist transcripts to DB
                    if event_data.get("type") == "transcript":
                        await db.db["transcripts"].insert_one({
                            "call_id": stream_sid,
                            "sender": event_data.get("sender"),
                            "text": event_data.get("text"),
                            "timestamp": datetime.utcnow()
                        })

                await el_session.start_session(
                    audio_callback=on_agent_audio,
                    status_callback=on_agent_event
                )
                active_sessions[stream_sid] = el_session
                print(f"[ElevenLabs] Agent session started for stream {stream_sid}")

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
            await db.db["calls"].update_one(
                {"call_id": stream_sid},
                {"$set": {"status": "completed", "end_time": datetime.utcnow()}}
            )
