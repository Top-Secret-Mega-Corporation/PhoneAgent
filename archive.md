# AI Voice Surrogate - Archive & Decision Log

## Initial Self-Reflection & Improvement Plan

### 1. Latency & Streaming Architecture
The requirement specifies a round-trip latency of under 1 second. A traditional "Wait for full human sentence" -> "STT" -> "Wait for full text" -> "Gemini" -> "Wait for full response" -> "TTS" -> "Play audio" pipeline will **fail** the 1-second latency requirement. 
**Improvement Plan:** We must implement a fully streaming architecture:
*   Stream audio from Twilio directly into ElevenLabs STT (chunk by chunk).
*   Send partial STT transcripts to Gemini and start generating responses using Gemini's streaming API.
*   Stream Gemini's text outputs sentence-by-sentence (or chunk-by-chunk) as soon as they are available directly to ElevenLabs TTS.
*   Pipe ElevenLabs TTS audio streams back to Twilio immediately.

### 2. Handling Interruptions (Barge-in)
The prompt mandates real-time interruption handling (if user submits text while the bot is preparing/speaking). For inbound/outbound calls, we also need to handle caller barge-in.
**Improvement Plan:** The WebSocket server must maintain state for the current generation sequence. Upon receiving an interrupt signal (new user text or caller speech detected), the server must:
1.  Immediately send a `clear` message to Twilio to flush its audio playback buffer.
2.  Cancel any ongoing Gemini streaming generation.
3.  Cancel any ongoing ElevenLabs TTS generation.
4.  Begin processing the new input immediately.

### 3. Twilio Media Formats
Twilio Media Streams strictly require audio in `audio/x-mulaw` with a sample rate of `8000`.
**Improvement Plan:** We must configure ElevenLabs TTS to return `ulaw_8000` (if natively supported) to avoid the overhead of transcoding in Python. If ElevenLabs only returns PCM/mp3, we will need to efficiently transcode it to µ-law using Python's `audioop` (deprecated in 3.13, so `pydub` or `ffmpeg` or `ulaw` specific libraries) before sending it to Twilio WebSocket. ElevenLabs natively supports µ-law 8000Hz format `ulaw_8000` which perfectly matches Twilio's requirements.

### 4. Direct TTS Mode vs Agent Mode Routing
The spell checker in Direct TTS mode needs to be context-aware and sub-second. 
**Improvement Plan:** Use Gemini for the spell-checking layer with a highly strict and small system prompt to ensure it only corrects obvious typos and doesn't hallucinate new sentences, ensuring latency is minimally impacted.

### 5. Local Webhook Exposure
To receive Twilio's incoming call webhooks and establish the initial WebSocket connection locally, we will need a tunneling tool.
**Improvement Plan:** We should use `ngrok` during local development to expose the FastAPI server.

---
