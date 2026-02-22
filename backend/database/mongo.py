import os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv()

MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017")
DB_NAME = "phone_agent"

class Database:
    def __init__(self):
        self.client = None
        self.db = None

    async def connect(self):
        self.client = AsyncIOMotorClient(MONGO_URI, serverSelectionTimeoutMS=500)
        self.db = self.client[DB_NAME]
        print("Connected to MongoDB")

    async def close(self):
        if self.client:
            self.client.close()
            print("Disconnected from MongoDB")

db = Database()
