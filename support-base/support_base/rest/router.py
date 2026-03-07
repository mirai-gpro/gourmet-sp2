import base64
import logging

from fastapi import APIRouter
from google.cloud import texttospeech
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter()

# Google Cloud TTS クライアント（シングルトン）
_tts_client = None


def _get_tts_client():
    global _tts_client
    if _tts_client is None:
        _tts_client = texttospeech.TextToSpeechClient()
    return _tts_client


class TTSSynthesizeRequest(BaseModel):
    text: str
    language_code: str = "ja-JP"
    voice_name: str = "ja-JP-Chirp3-HD-Leda"
    session_id: str = ""


@router.post("/tts/synthesize")
async def tts_synthesize(req: TTSSynthesizeRequest):
    """
    🚨 ショップ紹介時の長文TTS生成のみに使用
    通常会話には使用しない（LiveAPI WebSocket を使用）
    """
    try:
        client = _get_tts_client()

        synthesis_input = texttospeech.SynthesisInput(text=req.text)

        voice = texttospeech.VoiceSelectionParams(
            language_code=req.language_code,
            name=req.voice_name,
        )

        audio_config = texttospeech.AudioConfig(
            audio_encoding=texttospeech.AudioEncoding.MP3,
            speaking_rate=1.0,
        )

        response = client.synthesize_speech(
            input=synthesis_input,
            voice=voice,
            audio_config=audio_config,
        )

        audio_base64 = base64.b64encode(response.audio_content).decode("utf-8")

        return {
            "success": True,
            "audio": audio_base64,
        }

    except Exception as e:
        logger.error(f"TTS synthesis error: {e}")
        return {
            "success": False,
            "audio": "",
            "error": str(e),
        }
