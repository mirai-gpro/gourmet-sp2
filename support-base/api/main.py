"""
Gourmet Support - Voice Reservation API
Cloud Run用 FastAPI アプリケーション
"""

import os
import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# ログ設定
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# FastAPIアプリ作成
app = FastAPI(
    title="Gourmet Support Voice API",
    description="LLM電話予約システム - Twilio Webhook API",
    version="1.0.0"
)

# CORS設定
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Twilioルーター登録
from reservation.twilio_webhooks import router as twilio_router
app.include_router(twilio_router)


@app.get("/")
async def root():
    """ヘルスチェック"""
    return {
        "service": "Gourmet Support Voice API",
        "status": "running",
        "version": "1.0.0"
    }


@app.get("/health")
async def health_check():
    """Cloud Run ヘルスチェック"""
    return {"status": "healthy"}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)
