"""
FastAPI メインアプリケーション

エンドポイント一覧:
  POST /api/v2/session/start     → セッション開始
  POST /api/v2/session/end       → セッション終了
  WS   /api/v2/live/{session_id} → LiveAPI WebSocket
  POST /api/v2/rest/tts/synthesize → REST TTS（ショップ紹介用）
  POST /api/v2/rest/chat         → REST チャット（ショップ紹介用）
  GET  /health                   → ヘルスチェック
"""

from fastapi import FastAPI, WebSocket, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uuid
import logging

from .config import ALLOWED_ORIGINS
from .live.relay import LiveRelay
from .rest.router import router as rest_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Gourmet Support API v2")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# REST ルーター
app.include_router(rest_router)

# ========================================
# セッション管理
# ========================================

# セッションは RAM に保存（Cloud Run のインスタンス間で共有されない）
# session-affinity を有効にすること（cloudbuild.yaml 参照）
_sessions: dict = {}


class SessionStartRequest(BaseModel):
    user_info: dict = {}
    language: str = "ja"
    mode: str = "gourmet"  # "gourmet" or "concierge"


class SessionStartResponse(BaseModel):
    session_id: str
    initial_message: str


class SessionEndRequest(BaseModel):
    session_id: str


@app.post("/api/v2/session/start", response_model=SessionStartResponse)
async def start_session(req: SessionStartRequest):
    session_id = f"sess_{uuid.uuid4().hex[:12]}"
    _sessions[session_id] = {
        "language": req.language,
        "mode": req.mode,
        "user_info": req.user_info,
        "history": [],
    }
    # 初回メッセージは mode に応じて切り替え
    initial_message = "こんにちは！グルメサポートAIです。お食事のご希望をお聞かせください。"
    if req.mode == "concierge":
        initial_message = "いらっしゃいませ！グルメコンシェルジュです。どのようなお食事をお探しですか？"

    logger.info(f"[Session] Started: {session_id}, mode={req.mode}, lang={req.language}")
    return SessionStartResponse(session_id=session_id, initial_message=initial_message)


@app.post("/api/v2/session/end")
async def end_session(req: SessionEndRequest):
    if req.session_id in _sessions:
        del _sessions[req.session_id]
        logger.info(f"[Session] Ended: {req.session_id}")
        return {"session_id": req.session_id, "ended": True}
    raise HTTPException(status_code=404, detail=f"Session not found: {req.session_id}")


# ========================================
# LiveAPI WebSocket
# ========================================

@app.websocket("/api/v2/live/{session_id}")
async def live_websocket(websocket: WebSocket, session_id: str):
    """
    WebSocket エンドポイント
    フロントエンドとの双方向通信を中継する。
    Gemini Live API <-> relay.py <-> WebSocket <-> フロントエンド
    """
    session = _sessions.get(session_id)
    if not session:
        await websocket.close(code=4004, reason="Session not found")
        return

    await websocket.accept()
    logger.info(f"[WS] Connected: {session_id}")

    relay = LiveRelay(websocket, session)
    try:
        await relay.run()
    except Exception as e:
        logger.error(f"[WS] Error: {session_id}: {e}", exc_info=True)
    finally:
        await relay.close()
        logger.info(f"[WS] Disconnected: {session_id}")


# ========================================
# 旧API互換（フロントエンド移行期間用）
# ========================================

@app.post("/api/session/start")
async def legacy_start_session(req: SessionStartRequest):
    """旧エンドポイント互換"""
    return await start_session(req)


@app.post("/api/session/end")
async def legacy_end_session(req: SessionEndRequest):
    """旧エンドポイント互換"""
    return await end_session(req)


@app.post("/api/tts/synthesize")
async def legacy_tts_synthesize(req: dict):
    """旧TTS互換 — rest/router.py にプロキシ"""
    from .rest.router import TTSSynthesizeRequest, synthesize_tts
    tts_req = TTSSynthesizeRequest(
        text=req.get("text", ""),
        language_code=req.get("language_code", "ja-JP"),
        voice_name=req.get("voice_name", "ja-JP-Chirp3-HD-Leda"),
        session_id=req.get("session_id", ""),
    )
    return await synthesize_tts(tts_req)


# ========================================
# ヘルスチェック
# ========================================

@app.get("/health")
async def health():
    return {"status": "ok"}
