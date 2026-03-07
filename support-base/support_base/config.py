import os

# Gemini
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash-live-001")

# Google Cloud TTS
TTS_LANGUAGE_MAP = {
    "ja": {"language_code": "ja-JP", "voice_name": "ja-JP-Chirp3-HD-Leda"},
    "en": {"language_code": "en-US", "voice_name": "en-US-Studio-O"},
    "zh": {"language_code": "cmn-CN", "voice_name": "cmn-CN-Wavenet-A"},
    "ko": {"language_code": "ko-KR", "voice_name": "ko-KR-Wavenet-A"},
}

# CORS
ALLOWED_ORIGINS = [
    "http://localhost:4321",
    "http://localhost:3000",
    "https://gourmet-sp2.vercel.app",
    "https://gourmet-sp2-*.vercel.app",
]

# Google Places API
GOOGLE_PLACES_API_KEY = os.environ.get("GOOGLE_PLACES_API_KEY", "")
