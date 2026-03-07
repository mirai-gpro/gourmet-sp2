"""
REST API ルーター
用途: ショップ紹介時の長文TTS生成のみ
通常会話には使用しない（LiveAPI WebSocket を使用）
"""

import base64
import logging
from fastapi import APIRouter
from pydantic import BaseModel
from google.cloud import texttospeech

from ..config import TTS_LANGUAGE_MAP

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/rest", tags=["REST API"])


class TTSSynthesizeRequest(BaseModel):
    text: str
    language_code: str = "ja-JP"
    voice_name: str = "ja-JP-Chirp3-HD-Leda"
    session_id: str = ""


class TTSSynthesizeResponse(BaseModel):
    success: bool
    audio: str = ""  # base64 MP3


@router.post("/tts/synthesize", response_model=TTSSynthesizeResponse)
async def synthesize_tts(req: TTSSynthesizeRequest):
    """
    TTS 処理順序:
    1. Google Cloud TTS で音声合成
    2. base64 エンコード
    3. レスポンス返却
    """
    try:
        client = texttospeech.TextToSpeechClient()

        synthesis_input = texttospeech.SynthesisInput(text=req.text)
        voice = texttospeech.VoiceSelectionParams(
            language_code=req.language_code,
            name=req.voice_name,
        )
        audio_config = texttospeech.AudioConfig(
            audio_encoding=texttospeech.AudioEncoding.MP3,
        )

        response = client.synthesize_speech(
            input=synthesis_input, voice=voice, audio_config=audio_config
        )

        audio_base64 = base64.b64encode(response.audio_content).decode("utf-8")

        logger.info(
            f"[TTS] Synthesized {len(req.text)} chars -> {len(response.audio_content)} bytes"
        )

        return TTSSynthesizeResponse(success=True, audio=audio_base64)

    except Exception as e:
        logger.error(f"[TTS] Error: {e}", exc_info=True)
        return TTSSynthesizeResponse(success=False)


class RestChatRequest(BaseModel):
    session_id: str
    message: str
    stage: str = "conversation"
    language: str = "ja"
    mode: str = "gourmet"


@router.post("/chat")
async def rest_chat(req: RestChatRequest):
    """
    REST チャットは LiveAPI の補助用
    ショップ紹介後の追加質問など、テキストベースの処理に使用
    """
    # TODO: support_core.py の SupportAssistant を使用して処理
    # gourmet-support の app_customer_support.py から移植
    return {
        "response": "LiveAPI WebSocket を使用してください。",
        "shops": [],
        "summary": None,
        "should_confirm": False,
    }
