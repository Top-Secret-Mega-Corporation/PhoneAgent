# AI Voice Surrogate Project

This project implements a real-time AI Voice Surrogate system, connecting Twilio phone calls with a React-based web interface via a Python FastAPI/WebSocket backend. It utilizes ElevenLabs for Text-to-Speech (TTS) and Speech-to-Text (STT), Gemini for AI conversational logic, and MongoDB for call and transcript logging.

## Features
- **Real-Time Transcripts**: Bi-directional transcription streaming for inbound and outbound calls.
- **Direct TTS Mode**: Spellchecked text inputs are explicitly spoken.
- **Agent Mode**: AI naturally converses based on short prompt inputs mid-call.
- **Interruption Support**: Typing explicitly overrides the bot's current actions to flush audio output instantly.
- **Outbound Dialing**: Dial out to verified endpoints straight from the React UI. 

---

## Local Setup Instructions for MacOS

### Prerequisites
Ensure you have the following installed on your machine:
- **Python 3.10+** (Recommend `brew install python`)
- **Node.js & npm 18+** (Recommend `brew install node`)
- **MongoDB** running locally on default port 27017 (`brew tap mongodb/brew && brew install mongodb-community && brew services start mongodb-community`)
- **Ngrok** (`brew install ngrok/ngrok/ngrok` or direct binary download)

### Step 1: Environment Variables
Create a `.env` file in the **root** of the `PhoneAgent` directory with the following API Keys:

```env
MONGO_URI=mongodb://localhost:27017
ELEVENLABS_API_KEY=your_elevenlabs_key
GEMINI_API_KEY=your_gemini_key
TWILIO_ACCOUNT_SID=your_twilio_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=+1234567890
```

*Note: Your `TWILIO_PHONE_NUMBER` must be exactly formatted with the `+` sign and country code, and MUST be an active/verified number you own.*

### Step 2: Running the Python Backend
The Python backend uses FastAPI to expose Webhooks and handle the WebSockets logic securely.

1. Open a terminal and navigate to the root `PhoneAgent` directory.
2. Initialize and activate a virtual environment:
   ```bash
   cd backend
   python3 -m venv venv
   source venv/bin/activate
   ```
3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. Start the Uvicorn server:
   ```bash
   cd ..
   uvicorn backend.main:app --host 0.0.0.0 --port 8000
   ```

### Step 3: Running the React Frontend
The Dashboard uses Next.js 16 (App Router) with Tailwind CSS.

1. Open a **new** terminal window and navigate to the frontend directory:
   ```bash
   cd PhoneAgent/frontend
   ```
2. Install npm packges:
   ```bash
   npm install
   ```
3. Run the development server:
   ```bash
   npm run dev
   ```
4. View the frontend at [http://localhost:3000](http://localhost:3000)

### Step 4: Exposing the Webhook via Ngrok
Because Twilio requires a public URL to send Webhooks to, we must proxy our `8000` port to the internet.

1. Open a **third** terminal window.
2. Ensure you have authenticated Ngrok (`ngrok config add-authtoken YOUR_TOKEN`).
3. Run the HTTP tunnel pointing to our backend port:
   ```bash
   ngrok http 8000
   ```

### Step 5: Configuring Twilio
1. Once Ngrok starts, copy the Forwarding URL (e.g., `https://something.ngrok-free.dev`).
2. Log into the Twilio Developer Console.
3. Find your active Phone Number > "Voice & Fax" settings.
4. Set "A CALL COMES IN" to a Webhook URL that looks precisely like: `https://[YOUR_NGROK_URL]/twiml` using POST.
5. Save the configuration.

You can now test outbound dialing through the UI at `localhost:3000` or dial the Twilio number directly to initiate the system inbound!
