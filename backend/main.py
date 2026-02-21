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
from backend.services.gemini_service import GeminiService
from backend.services.elevenlabs_service import ElevenLabsService

app = FastAPI(title="AI Voice Surrogate")

# Add CORS for the Next.js frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

gemini = GeminiService(system_instruction="You are a real-time voice surrogate bot. Keep responses CONCISE, conversational, and natural to speak. Do not use markdown like * or #.")
elevenlabs = ElevenLabsService()

# Global task to manage ongoing generation to allow cancellation
current_generation_task = None

@app.on_event("startup")
async def startup_db_client():
    await db.connect()

@app.on_event("shutdown")
async def shutdown_db_client():
    await db.close()

@app.get("/")
def read_root():
    return {"status": "ok", "message": "PhoneAgent Backend is running!"}

def get_base_url(request: Request):
    """Attempt to dynamically get ngrok URL for Twilio, fallback to request host"""
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
    twiml = generate_twiml(ws_url)
    return Response(content=twiml, media_type="text/xml")

class CallRequest(BaseModel):
    to_number: str

@app.post("/call")
async def make_call(call_req: CallRequest, request: Request):
    base_url = get_base_url(request)
    # The webhook Twilio should call when the recipient picks up
    webhook_url = f"{base_url}/twiml"
    try:
        call_sid = initiate_outbound_call(call_req.to_number, webhook_url)
        return {"status": "success", "call_sid": call_sid}
    except Exception as e:
        return Response(content=str(e), status_code=500)


@app.websocket("/ui-stream")
async def ui_stream(websocket: WebSocket):
    await manager.connect_ui(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            action = msg.get("action")
            text = msg.get("text")
            
            if not text: continue
            
            # Send caller text directly to UI transcript as a "user acting as bot"
            # But wait, the frontend says sender 'caller' is the person on the phone,
            # sender 'bot' is the AI. Here the user typed something. So we'll trace it.
            # We can log it as the bot's intended message for the transcript.
            
            # Record what the user typed as the 'caller' text for UI context
            # Actually frontend sets sender='bot' for its own messages or caller?
            # Let's align: UI expects 'bot' or 'caller'. 
            # We will stream the final AI response to 'bot'. 
            # We'll broadcast what user typed as 'caller' for now just to show it.
            await manager.broadcast_ui({"type": "transcript", "sender": "caller", "text": f"[You]: {text}"})
            
            # Log pseudo-caller input to DB
            if manager.current_stream_sid:
                await db.db["transcripts"].insert_one({
                    "call_id": manager.current_stream_sid,
                    "sender": "caller",
                    "text": f"[You]: {text}",
                    "timestamp": datetime.utcnow()
                })

            # Handle Interruption: cancel existing generation
            global current_generation_task
            if current_generation_task and not current_generation_task.done():
                current_generation_task.cancel()
                # Clear twilio buffer
                if manager.current_stream_sid:
                    await manager.clear_twilio_buffer(manager.current_stream_sid)

            if action == "direct_tts":
                # Spell checking mode: short prompt to Gemini to fix spelling only
                async def direct_tts_flow():
                    try:
                        await manager.broadcast_ui({"type": "status", "status": "bot_preparing"})
                        corrected_text_generator = gemini.generate_streaming_response(
                            f"Correct any obvious typos in this text so it sounds perfect when spoken. Return exactly the corrected text and nothing else. text: {text}"
                        )
                        await process_and_stream_audio(corrected_text_generator)
                    except asyncio.CancelledError:
                        pass
                
                current_generation_task = asyncio.create_task(direct_tts_flow())
            
            elif action == "agent_prompt":
                # Agent Mode: conversational response
                async def agent_flow():
                    try:
                        await manager.broadcast_ui({"type": "status", "status": "bot_preparing"})
                        response_generator = gemini.generate_streaming_response(
                            f"Generate a conversational spoken response to this prompt: {text}"
                        )
                        await process_and_stream_audio(response_generator)
                    except asyncio.CancelledError:
                        pass
                
                current_generation_task = asyncio.create_task(agent_flow())

    except WebSocketDisconnect:
        manager.disconnect_ui(websocket)


async def process_and_stream_audio(text_generator):
    """Takes a generator of text chunks, streams audio to Twilio concurrently."""
    audio_queue = asyncio.Queue()
    
    stream_sid = manager.current_stream_sid
    if not stream_sid:
        return
        
    full_text = ""
    
    # Task to read audio from queue and send to twilio
    async def send_audio_to_twilio_task():
        while True:
            chunk = await audio_queue.get()
            if chunk is None: # End of stream
                break
            await manager.send_audio_to_twilio(stream_sid, chunk)

    twilio_sender = asyncio.create_task(send_audio_to_twilio_task())

    # Create a wrapper iterator to extract the full text while yielded
    async def text_iterator():
        nonlocal full_text
        async for chunk in text_generator:
            full_text += chunk
            yield chunk

    # Stream text to ElevenLabs and put audio chunks in queue
    await elevenlabs.tts_stream_generator(text_iterator(), audio_queue)
    
    # Once TTS stream is fully received, await the sender to close
    await audio_queue.put(None) 
    await twilio_sender
    
    # Broadcast full generated text back to UI
    if full_text.strip():
        await manager.broadcast_ui({"type": "transcript", "sender": "bot", "text": full_text.strip()})
        await db.db["transcripts"].insert_one({
            "call_id": stream_sid,
            "sender": "bot",
            "text": full_text.strip(),
            "timestamp": datetime.utcnow()
        })


@app.websocket("/media-stream")
async def media_stream(websocket: WebSocket):
    await websocket.accept()
    stream_sid = None
    stt_queue = asyncio.Queue()
    stt_task = None
    
    # Callback for when STT receives text
    async def stt_callback(text: str, is_final: bool):
        if text.strip() and is_final:
            await manager.broadcast_ui({"type": "transcript", "sender": "caller", "text": text})
            await db.db["transcripts"].insert_one({
                "call_id": stream_sid,
                "sender": "caller",
                "text": text,
                "timestamp": datetime.utcnow()
            })

    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)

            if msg["event"] == "connected":
                pass
            elif msg["event"] == "start":
                stream_sid = msg["start"]["streamSid"]
                await manager.connect_twilio(websocket, stream_sid)
                
                # Register Call in DB
                await db.db["calls"].insert_one({
                    "call_id": stream_sid,
                    "twilio_call_sid": stream_sid,
                    "status": "in_progress",
                    "direction": "inbound",  # Assuming inbound for webhook by default
                    "start_time": datetime.utcnow()
                })
                
                # Start STT Analyzer background task
                stt_task = asyncio.create_task(elevenlabs.stt_stream_analyzer(stt_queue, stt_callback))
                
            elif msg["event"] == "media":
                payload = msg["media"]["payload"]
                # Pass incoming audio payload to ElevenLabs STT Queue
                await stt_queue.put(payload)
                
            elif msg["event"] == "stop":
                if stream_sid:
                    manager.disconnect_twilio(stream_sid)
                    await db.db["calls"].update_one(
                        {"call_id": stream_sid}, 
                        {"$set": {"status": "completed", "end_time": datetime.utcnow()}}
                    )
                await stt_queue.put(None)
                break
    except WebSocketDisconnect:
        if stream_sid:
            manager.disconnect_twilio(stream_sid)
        await stt_queue.put(None)
