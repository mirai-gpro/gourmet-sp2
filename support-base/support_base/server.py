import uuid
import logging
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .config import ALLOWED_ORIGINS
from .live.relay import LiveRelay
from .rest.router import router as rest_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Gourmet Support Base")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(rest_router, prefix="/api/v2/rest")

# セッション管理（インメモリ）
sessions: dict[str, dict] = {}

PROMPTS_DIR = Path(__file__).parent.parent / "prompts"


class SessionStartRequest(BaseModel):
    user_info: dict = {}
    language: str = "ja"
    mode: str = "gourmet"


class SessionEndRequest(BaseModel):
    session_id: str


def _load_system_prompt(mode: str) -> str:
    prompt_file = PROMPTS_DIR / f"system_{mode}.txt"
    if prompt_file.exists():
        return prompt_file.read_text(encoding="utf-8")
    return ""


def _get_initial_message(language: str) -> str:
    messages = {
        "ja": "こんにちは！グルメサポートAIです。どのようなお店をお探しですか？",
        "en": "Hello! I'm the Gourmet Support AI. What kind of restaurant are you looking for?",
        "zh": "你好！我是美食支援AI。您在找什么样的餐厅？",
        "ko": "안녕하세요! 미식 서포트 AI입니다. 어떤 가게를 찾고 계신가요?",
    }
    return messages.get(language, messages["ja"])


@app.post("/api/v2/session/start")
async def session_start(req: SessionStartRequest):
    session_id = f"sess_{uuid.uuid4().hex[:12]}"
    system_prompt = _load_system_prompt(req.mode)

    sessions[session_id] = {
        "language": req.language,
        "mode": req.mode,
        "system_prompt": system_prompt,
        "user_info": req.user_info,
    }

    initial_message = _get_initial_message(req.language)

    logger.info(f"Session started: {session_id} (mode={req.mode}, lang={req.language})")

    # 🚨 ws_url は返さない — フロントエンドが session_id から WebSocket URL を構築する
    return {
        "session_id": session_id,
        "initial_message": initial_message,
    }


@app.post("/api/v2/session/end")
async def session_end(req: SessionEndRequest):
    session_id = req.session_id
    if session_id in sessions:
        del sessions[session_id]
        logger.info(f"Session ended: {session_id}")
    return {"session_id": session_id, "ended": True}


@app.websocket("/api/v2/live/{session_id}")
async def websocket_live(websocket: WebSocket, session_id: str):
    await websocket.accept()

    session = sessions.get(session_id)
    if not session:
        await websocket.send_json({"type": "error", "message": "Invalid session_id"})
        await websocket.close()
        return

    relay = LiveRelay(
        websocket=websocket,
        session=session,
    )

    try:
        await relay.run()
    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected: {session_id}")
    except Exception as e:
        logger.error(f"WebSocket error: {session_id}: {e}")
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        await relay.close()


@app.get("/health")
async def health():
    return {"status": "ok"}
