import os
import google.generativeai as genai
from dotenv import load_dotenv

load_dotenv()

genai.configure(api_key=os.getenv("GEMINI_API_KEY"))

# Using the fast model for latency-sensitive applications
MODEL_NAME = "gemini-2.5-flash"

class GeminiService:
    def __init__(self, system_instruction: str = None):
        self.model = genai.GenerativeModel(
            model_name=MODEL_NAME,
            system_instruction=system_instruction
        )
        self.chat = self.model.start_chat()

    async def generate_streaming_response(self, user_text: str):
        """
        Sends user text to Gemini and yields streaming response chunks.
        """
        try:
            # Using async streaming
            response = await self.chat.send_message_async(user_text, stream=True)
            async for chunk in response:
                if chunk.text:
                    yield chunk.text
        except Exception as e:
            print(f"Error communicating with Gemini: {e}")
            yield "I'm sorry, I'm experiencing a momentary glitch."
