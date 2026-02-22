import os
import logging
from twilio.rest import Client
from twilio.twiml.voice_response import VoiceResponse, Connect
from twilio.base.exceptions import TwilioRestException
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.ERROR)
logger = logging.getLogger(__name__)

TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN")
TWILIO_PHONE_NUMBER = os.getenv("TWILIO_PHONE_NUMBER")

twilio_client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) if TWILIO_ACCOUNT_SID else None

def initiate_outbound_call(to_number: str, webhook_url: str):
    if not twilio_client:
        raise Exception("Twilio credentials not configured.")
    
    # Log what we're sending
    logger.debug(f"Initiating call to: {to_number}")
    logger.debug(f"From: {TWILIO_PHONE_NUMBER}")
    logger.debug(f"Webhook URL: {webhook_url}")

    try:
        call = twilio_client.calls.create(
            to=to_number,
            from_=TWILIO_PHONE_NUMBER,
            url=webhook_url,
            method="POST"
        )
        logger.info(f"Call initiated successfully. SID: {call.sid}")
        return call.sid
    
    except TwilioRestException as e:
        logger.error(f"Twilio REST error: {e.status} - {e.code} - {e.msg}")
        logger.error(f"More info: {e.uri}")
        raise
    except Exception as e:
        logger.error(f"Unexpected error initiating call: {str(e)}")
        raise


def generate_twiml(websocket_url: str):
    logger.debug(f"Generating TwiML for WebSocket URL: {websocket_url}")
    
    response = VoiceResponse()
    connect = Connect()
    connect.stream(url=websocket_url)
    response.append(connect)
    
    twiml = str(response)
    logger.debug(f"Generated TwiML: {twiml}")
    return twiml