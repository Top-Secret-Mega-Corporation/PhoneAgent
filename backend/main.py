import json
import asyncio
import urllib.request
from datetime import datetime
from fastapi import FastAPI, WebSocket, Request, Response, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from backend.database.mongo import db
from backend.services.twilio_service import generate_twiml, initiate_outbound_call, twilio_client
from backend.services.connection_manager import manager
from backend.services.elevenlabs_service import ElevenLabsService

print(">>> SERVER STARTING UP", flush=True)

app = FastAPI(title="AI Voice Surrogate")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

elevenlabs = ElevenLabsService()

current_generation_task = None

@app.on_event("startup")
async def startup_db_client():
    await db.connect()
    print(">>> DB connected", flush=True)

@app.on_event("shutdown")
async def shutdown_db_client():
    await db.close()
    print(">>> DB disconnected", flush=True)

@app.get("/")
def read_root():
    return {"message": "Hello from PhoneAgent FastAPI Backend!"}

@app.post("/hangup")
async def end_active_call():
    """Allows UI to manually end the active Twilio call."""
    if manager.current_call_sid and twilio_client:
        try:
            twilio_client.calls(manager.current_call_sid).update(status="completed")
            print(f">>> HANGUP trigger sent for {manager.current_call_sid}")
            return {"status": "success", "call_sid": manager.current_call_sid}
        except Exception as e:
            print(f">>> HANGUP Failed: {e}")
            return {"status": "error", "reason": str(e)}
    return {"status": "no_active_call"}

def get_base_url(request: Request):
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

@app.api_route("/twiml", methods=["GET", "POST"])
async def twiml_bot(request: Request):
    base_url = get_base_url(request)
    ws_url = base_url.replace("https://", "wss://").replace("http://", "ws://") + "/media-stream"
    print(f">>> /twiml hit — ws_url={ws_url}", flush=True)
    twiml = generate_twiml(ws_url)
    return Response(content=twiml, media_type="text/xml")

class CallRequest(BaseModel):
    to_number: str

@app.post("/call")
async def make_call(call_req: CallRequest, request: Request):
    base_url = get_base_url(request)
    webhook_url = f"{base_url}/twiml"
    print(f">>> /call hit — to={call_req.to_number} webhook={webhook_url}", flush=True)
    try:
        call_sid = initiate_outbound_call(call_req.to_number, webhook_url)
        return {"status": "success", "call_sid": call_sid}
    except Exception as e:
        return Response(content=str(e), status_code=500)


@app.websocket("/ui-stream")
async def ui_stream(websocket: WebSocket):
    print(">>> UI STREAM connected", flush=True)
    await manager.connect_ui(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            action = msg.get("action")
            text = msg.get("text")

            if not text:
                continue

            print(f">>> UI action={action} text={text!r}", flush=True)

            if action == "agent_prompt":
                await manager.broadcast_ui({"type": "transcript", "sender": "user", "text": text})
            elif action == "direct_tts":
                # Show immediately as bot
                await manager.broadcast_ui({"type": "transcript", "sender": "bot", "text": text})

                if manager.current_stream_sid:
                    await db.db["transcripts"].insert_one({
                        "call_id": manager.current_stream_sid,
                        "sender": "bot",
                        "text": text,
                        "timestamp": datetime.utcnow()
                    })

            global current_generation_task
            if current_generation_task and not current_generation_task.done():
                print(">>> Cancelling existing generation task", flush=True)
                current_generation_task.cancel()
                if manager.current_stream_sid:
                    await manager.clear_twilio_buffer(manager.current_stream_sid)

            if action == "direct_tts":
                async def direct_tts_flow():
                    try:
                        await manager.broadcast_ui({"type": "status", "status": "bot_preparing"})
                        await process_and_stream_audio(text, broadcast_transcript=False)
                    except asyncio.CancelledError:
                        print(">>> direct_tts_flow cancelled", flush=True)

                current_generation_task = asyncio.create_task(direct_tts_flow())

    except WebSocketDisconnect:
        print(">>> UI STREAM disconnected", flush=True)
        manager.disconnect_ui(websocket)


async def process_and_stream_audio(text: str, broadcast_transcript: bool = True):
    """Takes a text string, streams TTS audio to Twilio."""
    audio_queue = asyncio.Queue()

    stream_sid = manager.current_stream_sid
    if not stream_sid:
        print(">>> process_and_stream_audio: no stream_sid, aborting", flush=True)
        return

    async def send_audio_to_twilio_task():
        chunk_count = 0
        while True:
            chunk = await audio_queue.get()
            if chunk is None:
                print(f">>> Twilio audio sender done — sent {chunk_count} chunks", flush=True)
                break
            chunk_count += 1
            await manager.send_audio_to_twilio(stream_sid, chunk)

    twilio_sender = asyncio.create_task(send_audio_to_twilio_task())

    async def text_iterator():
        yield text

    await elevenlabs.tts_stream_generator(text_iterator(), audio_queue)

    await audio_queue.put(None)
    await twilio_sender

    print(f">>> TTS complete for: {text!r}", flush=True)
    if broadcast_transcript:
        await manager.broadcast_ui({"type": "transcript", "sender": "bot", "text": text})
        await db.db["transcripts"].insert_one({
            "call_id": stream_sid,
            "sender": "bot",
            "text": text,
            "timestamp": datetime.utcnow()
        })


@app.websocket("/media-stream")
async def media_stream(websocket: WebSocket):
    print(">>> MEDIA STREAM HIT", flush=True)
    await websocket.accept()
    stream_sid = None
    stt_queue = asyncio.Queue()
    stt_task = None

    async def stt_callback(text: str, is_final: bool):
        print(f">>> STT CALLBACK is_final={is_final} text={text!r}", flush=True)
        if text.strip() and is_final:
            await manager.broadcast_ui({"type": "transcript", "sender": "caller", "text": text})
            await db.db["transcripts"].insert_one({
                "call_id": stream_sid,
                "sender": "caller",
                "text": text,
                "timestamp": datetime.utcnow()
            })
        elif text.strip() and not is_final:
            await manager.broadcast_ui({"type": "partial_transcript", "sender": "caller", "text": text})

    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            event = msg["event"]

            if event == "connected":
                print(">>> Twilio connected event", flush=True)

            elif event == "start":
                stream_sid = msg["start"]["streamSid"]
                call_sid = msg["start"]["callSid"]
                print(f">>> STREAM STARTED sid={stream_sid} call_sid={call_sid}", flush=True)
                await manager.connect_twilio(websocket, stream_sid, call_sid)

                await db.db["calls"].insert_one({
                    "call_id": stream_sid,
                    "twilio_call_sid": stream_sid,
                    "status": "in_progress",
                    "direction": "inbound",
                    "start_time": datetime.utcnow()
                })

                stt_task = asyncio.create_task(elevenlabs.stt_stream_analyzer(stt_queue, stt_callback))

                def stt_task_done(task):
                    try:
                        task.result()
                        print(">>> STT task completed cleanly", flush=True)
                    except Exception as e:
                        print(f">>> STT TASK DIED: {e}", flush=True)

                stt_task.add_done_callback(stt_task_done)
                print(">>> STT task started", flush=True)

            elif event == "media":
                payload = msg["media"]["payload"]
                print(f">>> MEDIA CHUNK len={len(payload)}", flush=True)
                await stt_queue.put(payload)

            elif event == "stop":
                print(">>> STREAM STOPPED", flush=True)
                if stream_sid:
                    manager.disconnect_twilio(stream_sid)
                    await db.db["calls"].update_one(
                        {"call_id": stream_sid},
                        {"$set": {"status": "completed", "end_time": datetime.utcnow()}}
                    )
                await stt_queue.put(None)
                break

    except WebSocketDisconnect:
        print(">>> MEDIA STREAM WebSocketDisconnect", flush=True)
        if stream_sid:
            manager.disconnect_twilio(stream_sid)
        await stt_queue.put(None)