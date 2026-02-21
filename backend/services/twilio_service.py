import os
from twilio.rest import Client
from twilio.twiml.voice_response import VoiceResponse, Connect
from dotenv import load_dotenv

load_dotenv()

TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN")
TWILIO_PHONE_NUMBER = os.getenv("TWILIO_PHONE_NUMBER")

# Initialize Twilio Client only if credentials are available
twilio_client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) if TWILIO_ACCOUNT_SID else None

def initiate_outbound_call(to_number: str, webhook_url: str):
    """
    Initiates an outbound call via Twilio REST API.
    """
    if not twilio_client:
        raise Exception("Twilio credentials not configured.")
        
    call = twilio_client.calls.create(
        to=to_number,
        from_=TWILIO_PHONE_NUMBER,
        url=webhook_url,
        method="POST"
    )
    return call.sid



def generate_twiml(websocket_url: str):
    """
    Generates TwiML connecting the active call to our Media Stream WebSocket.
    """
    response = VoiceResponse()
    connect = Connect()
    connect.stream(url=websocket_url)
    response.append(connect)
    return str(response)
