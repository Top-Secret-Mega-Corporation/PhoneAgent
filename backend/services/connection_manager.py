import asyncio
import json
from fastapi import WebSocket

class ConnectionManager:
    def __init__(self):
        self.ui_websockets: list[WebSocket] = []
        self.twilio_websockets: dict[str, WebSocket] = {}
        # current active twilio streamsid (assuming one active call for simplicity)
        self.current_stream_sid = None

    async def connect_ui(self, websocket: WebSocket):
        await websocket.accept()
        self.ui_websockets.append(websocket)
        print("UI WebSocket connected")

    def disconnect_ui(self, websocket: WebSocket):
        if websocket in self.ui_websockets:
            self.ui_websockets.remove(websocket)
            print("UI WebSocket disconnected")

    async def connect_twilio(self, websocket: WebSocket, stream_sid: str):
        self.twilio_websockets[stream_sid] = websocket
        self.current_stream_sid = stream_sid
        print(f"Twilio WebSocket connected: {stream_sid}")
        # Notify UI that call started
        await self.broadcast_ui({"type": "status", "status": "call_started"})

    def disconnect_twilio(self, stream_sid: str):
        if stream_sid in self.twilio_websockets:
            del self.twilio_websockets[stream_sid]
            print(f"Twilio WebSocket disconnected: {stream_sid}")
        if self.current_stream_sid == stream_sid:
            self.current_stream_sid = None
        # Notify UI that call ended if no active calls
        asyncio.create_task(self.broadcast_ui({"type": "status", "status": "call_ended"}))

    async def broadcast_ui(self, message: dict):
        for connection in self.ui_websockets:
            try:
                await connection.send_json(message)
            except Exception as e:
                print(f"Failed to send to UI ws: {e}")

    async def send_to_twilio(self, stream_sid: str, message: dict):
        if stream_sid in self.twilio_websockets:
            ws = self.twilio_websockets[stream_sid]
            try:
                await ws.send_json(message)
            except Exception as e:
                print(f"Failed to send to Twilio ws: {e}")

    async def send_audio_to_twilio(self, stream_sid: str, base64_audio: str):
        message = {
            "event": "media",
            "streamSid": stream_sid,
            "media": {
                "payload": base64_audio
            }
        }
        await self.send_to_twilio(stream_sid, message)

    async def clear_twilio_buffer(self, stream_sid: str):
        """Interrupts Twilio by clearing its audio buffer."""
        message = {
            "event": "clear",
            "streamSid": stream_sid
        }
        await self.send_to_twilio(stream_sid, message)

manager = ConnectionManager()
