# グルメサポートAI 新バージョン 設計仕様書

**日付**: 2026-03-07
**バージョン**: v2.0
**ステータス**: レビュー待ち

---

## 🚨 AIへの注意事項（原則7: AIの知識が不足）

```
🚨 以下の技術について、AIは正確な知識を持っていない：
1. Gemini Live API (google.genai の Live API) — 2025年後半にリリースされた新しいAPI
   - ドキュメント: https://ai.google.dev/gemini-api/docs/live
   - SDKの正確なインターフェースは変更される可能性がある
   - 必ず google-genai の最新バージョンのドキュメントを参照すること
2. Audio2Expression (A2E) — フェーズ2で使用、独自サービス
   - このドキュメントでは扱わない（フェーズ2で別途仕様書を作成）

🚨 AIがやりがちな間違い：
- genai.Client() と genai.GenerativeModel() を混同する
- Live API の connect() メソッドのシグネチャを間違える
- WebSocket のメッセージフォーマットを推測で書く
- 存在しないメソッドやプロパティを自信を持って使う

🚨 対策：
- 既存の動作するコード（gourmet-support の support_core.py）をベースにする
- Live API 部分は最小限の変更にとどめる
- 不明な部分はTODOコメントで明示し、手動検証を要求する
```

---

## 前提条件

| 項目 | 状態 |
|------|------|
| グルメモード（REST API） | 正常稼働中 |
| コンシェルジュモード（REST API） | 正常稼働中 |
| コンシェルジュモード（A2Eリップシンク） | 実証テスト成功（70点） |
| LiveAPI（会議アシスタント stt_stream.py） | 本番稼働中 |

---

## フェーズ構成

| フェーズ | 内容 | 依存関係 |
|----------|------|----------|
| **フェーズ1** | REST API → LiveAPI 変換（ショップカード以外） | なし |
| **フェーズ2** | A2Eアバターリップシンクをコンシェルジュモードに追加 | フェーズ1完了後 |

---

## フェーズ1: LiveAPI 化

### アーキテクチャ概要

```
🚨 この図の通りに実装すること。追加・省略しない。

┌─────────────────────────────────────────────────────┐
│ フロントエンド (Astro + TypeScript)                    │
│                                                       │
│  ┌─────────────┐  ┌──────────────┐                   │
│  │ GourmetChat  │  │  Concierge   │                   │
│  │ (グルメモード) │  │(コンシェルジュ)│                   │
│  └──────┬───────┘  └──────┬───────┘                   │
│         │                  │                           │
│  ┌──────▼──────────────────▼───────┐                  │
│  │       CoreController            │                   │
│  │  ・LiveAPI WebSocket接続        │                   │
│  │  ・音声入出力管理               │                   │
│  │  ・ショップカード時のみREST呼出  │                   │
│  └──────┬──────────────────┬───────┘                  │
│         │ WebSocket        │ REST (ショップ紹介のみ)    │
└─────────┼──────────────────┼──────────────────────────┘
          │                  │
┌─────────▼──────────────────▼──────────────────────────┐
│ バックエンド (FastAPI + Python)  [support-base/]       │
│                                                       │
│  ┌──────────────┐  ┌──────────────┐                   │
│  │ server.py    │  │ rest/        │                   │
│  │ (FastAPI app) │  │  router.py  │                   │
│  │              │  │  (REST API)  │                   │
│  └──────┬───────┘  └──────────────┘                   │
│         │                                              │
│  ┌──────▼───────┐  ┌──────────────┐                   │
│  │ live/        │  │ support_     │                   │
│  │  relay.py   │  │  core.py     │                   │
│  │ (LiveAPI中継) │  │ (共通ロジック) │                   │
│  └──────┬───────┘  └──────────────┘                   │
│         │                                              │
│  ┌──────▼───────┐                                     │
│  │ Gemini       │                                     │
│  │ Live API     │                                     │
│  └──────────────┘                                     │
└───────────────────────────────────────────────────────┘
```

### やらないこと（原則5）

```
🚨 以下は実装しない：
1. REST API のフォールバック — LiveAPI が動かなければアプリの意味がない
2. Socket.IO による STT — LiveAPI が STT/TTS 両方を担当する
3. AudioManager の既存 Socket.IO ストリーミング — LiveAPI の WebSocket に置き換え
4. 独自の VAD 実装 — Gemini Live API が内蔵の VAD を使用
5. フロントエンドからの直接 Gemini API 呼び出し — バックエンド経由のみ
6. pre-generated acknowledgment audio — LiveAPI がリアルタイムで応答するため不要
7. generateFallbackResponse — LiveAPI がリアルタイムで応答するため不要
```

---

### ディレクトリ構成

```
🚨 この構成の通りに作成すること

gourmet-sp2/
├── src/                          # フロントエンド（既存 + 修正）
│   ├── scripts/chat/
│   │   ├── core-controller.ts    # 🚨 大幅修正: LiveAPI WebSocket接続
│   │   ├── chat-controller.ts    # 最小限の修正
│   │   ├── concierge-controller.ts # 最小限の修正
│   │   └── audio-manager.ts      # 🚨 大幅修正: LiveAPI用に書き換え
│   ├── components/               # 既存コンポーネント（変更なし）
│   └── pages/                    # 既存ページ（変更なし）
│
├── support-base/                 # 🚨 新規: バックエンド
│   ├── Dockerfile
│   ├── cloudbuild.yaml
│   ├── requirements.txt
│   ├── support_base/
│   │   ├── __init__.py
│   │   ├── server.py             # FastAPI メインアプリ
│   │   ├── config.py             # 設定・環境変数
│   │   ├── support_core.py       # Gemini チャットロジック（gourmet-supportから移植）
│   │   ├── live/
│   │   │   ├── __init__.py
│   │   │   └── relay.py          # Gemini Live API WebSocket 中継
│   │   └── rest/
│   │       ├── __init__.py
│   │       └── router.py         # REST API（ショップ紹介TTS用）
│   └── prompts/
│       ├── system_gourmet.txt    # グルメモード用システムプロンプト
│       └── system_concierge.txt  # コンシェルジュモード用システムプロンプト
```

---

### 処理フロー（番号付き厳守 — 原則3）

#### フロー1: セッション開始

```
🚨 この順序を変更しない

1. フロントエンド: POST /api/v2/session/start { language: "ja", mode: "gourmet" }
2. バックエンド: session_id を生成（UUID）
3. バックエンド: SupportSession を作成、RAM に保存
4. バックエンド: レスポンス { session_id: "sess_xxx", initial_message: "..." }
5. フロントエンド: session_id を保存
6. フロントエンド: WebSocket接続を開始 → ws://{apiBase}/api/v2/live/{session_id}
7. バックエンド: Gemini Live API セッションを開始
8. バックエンド: WebSocket 接続確立、{ type: "connected" } を送信
9. フロントエンド: 初回挨拶を表示 + TTS再生（REST経由）
```

#### フロー2: 通常会話（テキスト入力 or 音声入力）

```
🚨 この順序を変更しない

【テキスト入力の場合】
1. ユーザーがテキスト入力して送信ボタンを押す
2. フロントエンド: チャットエリアにユーザーメッセージを表示
3. フロントエンド: WebSocket送信 { type: "text", text: "渋谷でイタリアン" }
4. バックエンド (relay.py): テキストを Gemini Live API に送信
5. Gemini: テキスト応答を返す（ストリーミング）
6. バックエンド: { type: "text", text: "渋谷..." } を WebSocket でフロントエンドへ
7. Gemini: tool_call を返す場合 → フロー3へ
8. Gemini: turn_complete を返す
9. バックエンド: { type: "turn_complete" } を WebSocket で送信
10. フロントエンド: 完了した応答テキストをチャットエリアに表示
11. フロントエンド: TTS再生（REST /api/v2/rest/tts/synthesize 経由）

【音声入力の場合】
1. ユーザーがマイクボタンを押す
2. フロントエンド: マイク音声をキャプチャ開始
3. フロントエンド: PCM 16kHz 音声チャンクを WebSocket で送信
   { type: "audio", data: "<base64 PCM>" }
4. バックエンド (relay.py): 音声チャンクを Gemini Live API に転送
5. Gemini: 音声応答を返す（ストリーミング PCM）
6. バックエンド: { type: "audio", data: "<base64 PCM>" } を WebSocket で送信
7. フロントエンド: 受信した PCM を AudioContext で再生
8. Gemini: turn_complete を返す
9. バックエンド: { type: "turn_complete" } を送信
10. フロントエンド: 音声再生完了
```

#### フロー3: ショップ検索（tool_call → REST切替）

```
🚨 この順序を変更しない
🚨 ショップ紹介のセリフは長文になるため、REST API でTTS生成する

1. Gemini が tool_call を返す（レストラン検索 function calling）
2. バックエンド: tool_call を検知
3. バックエンド: Google Places API でレストラン検索を実行
4. バックエンド: 検索結果を Gemini に tool_response として返す
5. Gemini: ショップ紹介テキストを生成
6. バックエンド: ショップデータを構造化して WebSocket で送信
   {
     type: "shop_result",
     response: "ご希望に合うお店を5軒ご紹介します！...",
     shops: [{ name: "...", category: "...", ... }]
   }
7. バックエンド: turn_complete を送信
8. フロントエンド: ショップカードを表示（displayShops イベント）
9. フロントエンド: REST TTS でショップ紹介セリフを音声合成
   POST /api/v2/rest/tts/synthesize { text: "...", session_id: "..." }
10. フロントエンド: TTS音声を再生
```

---

### バックエンド仕様（具体値 — 原則1, 2）

#### support-base/requirements.txt

```
🚨 改変禁止 — このバージョンを使用すること

Flask==3.0.0
flask-cors==4.0.0
flask-socketio==5.3.5
python-socketio==5.10.0
google-genai>=1.0.0
google-cloud-texttospeech>=2.14.0
google-cloud-speech>=2.21.0
gunicorn==21.2.0
httpx>=0.25.0
requests>=2.31.0
uvicorn[standard]>=0.27.0
fastapi>=0.109.0
websockets>=12.0
pydantic>=2.5.0
```

#### support-base/support_base/config.py

```python
🚨 改変禁止

import os

# Gemini
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash-live-001")

# 🚨 Gemini Live API のモデル名は頻繁に変更される
# デプロイ時に環境変数 GEMINI_MODEL で最新モデルを指定すること
# 2026年3月時点の最新: gemini-2.0-flash-live-001

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
```

#### support-base/support_base/server.py

```python
🚨 改変禁止 — エンドポイントのパスとシグネチャを変更しない

"""
FastAPI メインアプリケーション
エンドポイント一覧:
  POST /api/v2/session/start     → セッション開始
  POST /api/v2/session/end       → セッション終了
  WS   /api/v2/live/{session_id} → LiveAPI WebSocket
  POST /api/v2/rest/chat         → REST チャット（ショップ紹介用）
  POST /api/v2/rest/tts/synthesize → REST TTS（ショップ紹介用）
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

# 🚨 セッションは RAM に保存（Cloud Run のインスタンス間で共有されない）
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
    # 🚨 初回メッセージは固定（長期記憶は将来対応）
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
    🚨 WebSocket エンドポイント
    フロントエンドとの双方向通信を中継する。
    Gemini Live API ←→ relay.py ←→ WebSocket ←→ フロントエンド
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
# ヘルスチェック
# ========================================

@app.get("/health")
async def health():
    return {"status": "ok"}
```

#### support-base/support_base/live/relay.py

```python
🚨 改変禁止の箇所を明示

"""
Gemini Live API WebSocket 中継

処理順序:
1. Gemini Live API セッションを開始
2. フロントエンドからのメッセージを受信
3. Gemini に転送
4. Gemini からの応答をフロントエンドに転送
5. tool_call を検知したら REST 経由で処理
"""

import asyncio
import base64
import json
import logging
from typing import Optional

from fastapi import WebSocket
from google import genai
from google.genai import types

from ..config import GEMINI_API_KEY, GEMINI_MODEL

logger = logging.getLogger(__name__)


class LiveRelay:
    def __init__(self, websocket: WebSocket, session: dict):
        self.websocket = websocket
        self.session = session
        self._gemini_session = None
        self._client = None
        self._running = False

    async def run(self):
        """
        🚨 処理順序（変更しない）:
        1. Gemini クライアント初期化
        2. Live API セッション開始
        3. フロントエンドに connected 通知
        4. 受信ループ開始（フロントエンド → Gemini）
        5. 応答ループ開始（Gemini → フロントエンド）
        """
        self._running = True

        # 1. Gemini クライアント初期化
        self._client = genai.Client(api_key=GEMINI_API_KEY)

        # 2. Live API セッション開始
        # 🚨 ここの API は google-genai のバージョンによって変わる可能性がある
        # 🚨 デプロイ前に必ず動作確認すること
        system_prompt = self._build_system_prompt()

        # 🚨 tool_declarations: レストラン検索用の function calling 定義
        tools = self._build_tools()

        config = types.LiveConnectConfig(
            response_modalities=["TEXT"],  # 🚨 テキスト応答のみ（音声はREST TTSで生成）
            system_instruction=types.Content(
                parts=[types.Part(text=system_prompt)]
            ),
            tools=tools,
        )

        # 🚨 API呼び出し — genai のバージョンによりインターフェースが異なる可能性
        async with self._client.aio.live.connect(
            model=GEMINI_MODEL,
            config=config,
        ) as gemini_session:
            self._gemini_session = gemini_session

            # 3. フロントエンドに connected 通知
            await self.websocket.send_json({"type": "connected"})

            # 4 & 5. 並行ループ
            await asyncio.gather(
                self._recv_from_frontend(),
                self._recv_from_gemini(),
            )

    async def _recv_from_frontend(self):
        """フロントエンドからのメッセージを受信して Gemini に転送"""
        try:
            while self._running:
                data = await self.websocket.receive_json()
                msg_type = data.get("type")

                if msg_type == "text":
                    # テキストメッセージ → Gemini に送信
                    text = data.get("text", "")
                    if text:
                        await self._gemini_session.send(
                            input=text,
                            end_of_turn=True,
                        )
                        logger.info(f"[Relay] Sent text to Gemini: {text[:50]}...")

                elif msg_type == "audio":
                    # 🚨 フェーズ1ではテキストのみ。音声入力は将来対応。
                    # 現在は Socket.IO STT でテキスト変換後に送信する
                    pass

                elif msg_type == "close":
                    self._running = False
                    break

        except Exception as e:
            logger.error(f"[Relay] Frontend recv error: {e}")
            self._running = False

    async def _recv_from_gemini(self):
        """Gemini からの応答を受信してフロントエンドに転送"""
        try:
            while self._running:
                # 🚨 Gemini Live API の応答ストリーム
                async for response in self._gemini_session.receive():
                    if not self._running:
                        break

                    sc = response.server_content
                    if not sc:
                        # tool_call の処理
                        if hasattr(response, 'tool_call') and response.tool_call:
                            await self._handle_tool_call(response.tool_call)
                        continue

                    # テキスト応答
                    if sc.model_turn and sc.model_turn.parts:
                        for part in sc.model_turn.parts:
                            if part.text:
                                await self.websocket.send_json({
                                    "type": "text",
                                    "text": part.text,
                                })

                    # ターン完了
                    if sc.turn_complete:
                        await self.websocket.send_json({"type": "turn_complete"})
                        logger.info("[Relay] Turn complete")

        except Exception as e:
            logger.error(f"[Relay] Gemini recv error: {e}")
            self._running = False

    async def _handle_tool_call(self, tool_call):
        """
        🚨 tool_call 処理順序（変更しない）:
        1. function_call の名前とパラメータを取得
        2. search_restaurants の場合: Google Places API でレストラン検索
        3. 検索結果を Gemini に tool_response として返す
        4. Gemini がショップ紹介テキストを生成
        5. ショップデータをフロントエンドに送信
        """
        for fc in tool_call.function_calls:
            if fc.name == "search_restaurants":
                args = fc.args or {}
                area = args.get("area", "")
                cuisine = args.get("cuisine", "")
                budget = args.get("budget", "")

                logger.info(f"[Relay] Tool call: search_restaurants(area={area}, cuisine={cuisine})")

                # Google Places API でレストラン検索
                shops = await self._search_restaurants(area, cuisine, budget)

                # 検索結果を Gemini に返す
                result_text = json.dumps(shops, ensure_ascii=False)
                await self._gemini_session.send(
                    input=types.Content(
                        parts=[types.Part(
                            function_response=types.FunctionResponse(
                                name="search_restaurants",
                                response={"result": result_text},
                            )
                        )]
                    ),
                    end_of_turn=False,
                )

                # ショップデータをフロントエンドに先行送信
                await self.websocket.send_json({
                    "type": "shop_data",
                    "shops": shops,
                })

    async def _search_restaurants(self, area: str, cuisine: str, budget: str) -> list:
        """
        🚨 Google Places API でレストラン検索
        gourmet-support の support_core.py から移植
        """
        import httpx
        from ..config import GOOGLE_PLACES_API_KEY

        query = f"{area} {cuisine} レストラン"
        if budget:
            query += f" {budget}"

        url = "https://maps.googleapis.com/maps/api/place/textsearch/json"
        params = {
            "query": query,
            "type": "restaurant",
            "key": GOOGLE_PLACES_API_KEY,
            "language": "ja",
        }

        shops = []
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(url, params=params)
                data = resp.json()

            for place in data.get("results", [])[:5]:
                name = place.get("name", "")
                encoded_name = name.replace(" ", "+")
                shop = {
                    "name": name,
                    "category": cuisine or "レストラン",
                    "description": place.get("formatted_address", ""),
                    "rating": place.get("rating"),
                    "priceRange": "",
                    "location": place.get("formatted_address", ""),
                    "image": "",
                    "hotpepper_url": f"https://www.hotpepper.jp/SA11/srchRS/?keyword={encoded_name}",
                    "maps_url": f"https://www.google.com/maps/search/{encoded_name}",
                    "tabelog_url": f"https://tabelog.com/rstLst/?vs=1&sa=&sk={encoded_name}",
                }

                # Google Places photo
                photos = place.get("photos", [])
                if photos and GOOGLE_PLACES_API_KEY:
                    photo_ref = photos[0].get("photo_reference", "")
                    if photo_ref:
                        shop["image"] = (
                            f"https://maps.googleapis.com/maps/api/place/photo"
                            f"?maxwidth=400&photo_reference={photo_ref}"
                            f"&key={GOOGLE_PLACES_API_KEY}"
                        )
                shops.append(shop)
        except Exception as e:
            logger.error(f"[Search] Google Places API error: {e}")

        return shops

    def _build_system_prompt(self) -> str:
        """
        🚨 システムプロンプト — mode に応じて切り替え
        """
        mode = self.session.get("mode", "gourmet")
        language = self.session.get("language", "ja")

        base_prompt = """あなたはグルメサポートAIです。ユーザーの食事の好みや要望を聞いて、最適なレストランを提案します。

## 応答ルール
- 丁寧で親しみやすい口調で応答してください
- ユーザーの要望（エリア、ジャンル、予算、人数など）を聞き出してください
- 十分な情報が集まったら search_restaurants 関数を呼び出してください
- 関数を呼び出す前に、ユーザーに確認してください

## 応答の長さ制限
🚨 LiveAPI応答は30文字以内（日本語）を目安にしてください
🚨 長い説明が必要な場合は複数ターンに分けてください
🚨 ショップ紹介は search_restaurants 関数の結果をもとに行います
"""

        if mode == "concierge":
            base_prompt += """
## コンシェルジュモード追加ルール
- より丁寧な接客口調で応答してください
- 「いらっしゃいませ」「承知しました」などの接客用語を使ってください
"""

        if language != "ja":
            lang_map = {"en": "English", "zh": "Chinese", "ko": "Korean"}
            base_prompt += f"\n## 言語\n{lang_map.get(language, 'Japanese')}で応答してください。\n"

        return base_prompt

    def _build_tools(self) -> list:
        """
        🚨 Function Calling 定義 — 変更しない
        """
        search_tool = types.Tool(
            function_declarations=[
                types.FunctionDeclaration(
                    name="search_restaurants",
                    description="指定されたエリア・ジャンル・予算でレストランを検索する",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "area": types.Schema(
                                type=types.Type.STRING,
                                description="検索エリア（例: 渋谷、新宿、恵比寿）",
                            ),
                            "cuisine": types.Schema(
                                type=types.Type.STRING,
                                description="料理ジャンル（例: イタリアン、和食、フレンチ）",
                            ),
                            "budget": types.Schema(
                                type=types.Type.STRING,
                                description="予算範囲（例: 3000-5000円）",
                            ),
                        },
                        required=["area"],
                    ),
                )
            ]
        )
        return [search_tool]

    async def close(self):
        """セッション終了"""
        self._running = False
        # Gemini セッションは async with で自動クローズ
```

#### support-base/support_base/rest/router.py

```python
🚨 改変禁止

"""
REST API ルーター
🚨 用途: ショップ紹介時の長文TTS生成のみ
🚨 通常会話には使用しない（LiveAPI WebSocket を使用）
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
    🚨 TTS 処理順序（変更しない）:
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

        logger.info(f"[TTS] Synthesized {len(req.text)} chars → {len(response.audio_content)} bytes")

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
    🚨 REST チャットは LiveAPI の補助用
    ショップ紹介後の追加質問など、テキストベースの処理に使用
    """
    # TODO: support_core.py の SupportAssistant を使用して処理
    # gourmet-support の app_customer_support.py から移植
    return {
        "response": "REST チャットは現在 LiveAPI WebSocket を使用してください。",
        "shops": [],
        "summary": None,
        "should_confirm": False,
    }
```

---

### フロントエンド仕様（具体値 — 原則1, 2）

#### WebSocket メッセージフォーマット

```typescript
🚨 改変禁止 — フロントエンド ↔ バックエンド間の WebSocket メッセージ

// フロントエンド → バックエンド
type ClientMessage =
  | { type: "text"; text: string }           // テキスト入力
  | { type: "audio"; data: string }          // 音声チャンク (base64 PCM 16kHz)
  | { type: "close" }                        // 切断

// バックエンド → フロントエンド
type ServerMessage =
  | { type: "connected" }                    // 接続確立
  | { type: "text"; text: string }           // テキスト応答（ストリーミング）
  | { type: "audio"; data: string }          // 音声応答 (base64 PCM)
  | { type: "turn_complete" }                // ターン完了
  | { type: "shop_data"; shops: Shop[] }     // ショップデータ
  | { type: "shop_result"; response: string; shops: Shop[] }  // ショップ紹介
  | { type: "error"; message: string }       // エラー
```

#### core-controller.ts 主要変更点

```typescript
🚨 以下の変更のみ行う。追加機能は実装しない。

// 1. LiveAPI WebSocket 接続の追加
protected liveWs: WebSocket | null = null;
protected responseBuffer: string = "";  // ストリーミングテキストバッファ

// 2. initSocket() を LiveAPI WebSocket に変更
//    🚨 Socket.IO は削除しない（STT ストリーミングは引き続き使用）
protected connectLiveAPI() {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${new URL(this.apiBase).host}/api/v2/live/${this.sessionId}`;
  this.liveWs = new WebSocket(wsUrl);
  // ... ハンドラ設定
}

// 3. sendMessage() を LiveAPI WebSocket 経由に変更
//    🚨 ショップカード表示後の TTS は REST API を使い続ける

// 4. 削除する機能:
//    - preGeneratedAcks（事前生成ACK音声）
//    - generateFallbackResponse（フォールバック応答）
//    - selectSmartAcknowledgment（即答選択）
//    - additionalResponse（追加応答）
```

---

### 移植元との対応表（原則6）

| 機能 | 移植元ファイル | 移植先ファイル | 備考 |
|------|--------------|--------------|------|
| セッション管理 | gourmet-support/app_customer_support.py `/api/session/start` | support-base/server.py `/api/v2/session/start` | エンドポイントパス変更 |
| チャット処理 | gourmet-support/support_core.py `SupportAssistant` | support-base/live/relay.py `LiveRelay` | REST→LiveAPI に変更 |
| TTS | gourmet-support/app_customer_support.py `/api/tts/synthesize` | support-base/rest/router.py `/api/v2/rest/tts/synthesize` | ほぼ同一 |
| ショップ検索 | gourmet-support/support_core.py `GoogleSearch` tool | support-base/live/relay.py `search_restaurants` | function calling に変更 |
| フロントエンド chat | gourmet-sp/core-controller.ts `sendMessage()` | gourmet-sp2/core-controller.ts `sendMessage()` | WebSocket 経由に変更 |
| フロントエンド STT | gourmet-sp/audio-manager.ts | gourmet-sp2/audio-manager.ts | Socket.IO STT は維持 |

---

### 検証条件（原則8）

```python
# バックエンド assert（テスト用）

# 1. セッション開始
response = client.post("/api/v2/session/start", json={"language": "ja", "mode": "gourmet"})
assert response.status_code == 200
data = response.json()
assert "session_id" in data
assert data["session_id"].startswith("sess_")
assert "initial_message" in data

# 2. TTS 合成
response = client.post("/api/v2/rest/tts/synthesize", json={
    "text": "こんにちは", "language_code": "ja-JP", "voice_name": "ja-JP-Chirp3-HD-Leda"
})
assert response.status_code == 200
data = response.json()
assert data["success"] == True
assert len(data["audio"]) > 100  # base64 エンコードされた MP3

# 3. ヘルスチェック
response = client.get("/health")
assert response.status_code == 200
assert response.json()["status"] == "ok"
```

```javascript
// フロントエンド assert（ブラウザコンソールで検証）

// 1. WebSocket 接続
assert(liveWs.readyState === WebSocket.OPEN, "WebSocket should be connected");

// 2. テキスト送信 → 応答受信
// WebSocket で { type: "text", text: "渋谷でイタリアン" } を送信
// → { type: "text", text: "..." } が返ること
// → { type: "turn_complete" } が返ること

// 3. ショップカード表示
// → { type: "shop_data", shops: [...] } が返ること
// → shops.length > 0
// → shops[0].name が空でないこと
```

---

### Dockerfile

```dockerfile
🚨 改変禁止

FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY support_base/ ./support_base/
COPY prompts/ ./prompts/

# 🚨 ポート 8080（Cloud Run デフォルト）
EXPOSE 8080

# 🚨 uvicorn で起動（gunicorn + uvicorn worker ではない）
# WebSocket サポートのため uvicorn を直接使用
CMD ["uvicorn", "support_base.server:app", "--host", "0.0.0.0", "--port", "8080", "--log-level", "info"]
```

### cloudbuild.yaml

```yaml
🚨 改変禁止

steps:
  - name: 'gcr.io/cloud-builders/docker'
    args: ['build', '-t', 'gcr.io/$PROJECT_ID/${_SERVICE_NAME}', '.']
  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', 'gcr.io/$PROJECT_ID/${_SERVICE_NAME}']
  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: gcloud
    args:
      - 'run'
      - 'deploy'
      - '${_SERVICE_NAME}'
      - '--image'
      - 'gcr.io/$PROJECT_ID/${_SERVICE_NAME}'
      - '--region'
      - '${_REGION}'
      - '--platform'
      - 'managed'
      - '--allow-unauthenticated'
      - '--session-affinity'       # 🚨 WebSocket接続を同一インスタンスに固定（必須）
      - '--timeout=3600'           # 🚨 WebSocket長時間接続に対応（1時間）
      - '--min-instances=1'        # 🚨 コールドスタート防止

substitutions:
  _SERVICE_NAME: support-base
  _REGION: us-central1             # 🚨 実際のデプロイ先リージョン

images:
  - 'gcr.io/$PROJECT_ID/${_SERVICE_NAME}'
```

---

### vercel.json（フロントエンド）

```json
🚨 改変禁止

{
  "framework": "astro",
  "rewrites": [
    {
      "source": "/api/v2/:path*",
      "destination": "https://support-base-XXXXX.us-central1.run.app/api/v2/:path*"
    }
  ],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Embedder-Policy", "value": "credentialless" },
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" }
      ]
    }
  ]
}
```

**注意**: `XXXXX` は実際の Cloud Run サービス ID に置き換えること。

---

## フェーズ2: A2E アバターリップシンク（別途仕様書作成）

フェーズ1完了後に着手。以下は概要のみ：

- コンシェルジュモードのTTS応答にA2Eで表情データを付与
- REST TTS エンドポイントに expression フィールドを追加
- LAMAvatar コンポーネントとの統合
- 既存の ConciergeController.applyExpressionFromTts() を活用

---

## 実装チェックリスト

### バックエンド (support-base/)
- [ ] ディレクトリ構成を作成
- [ ] requirements.txt
- [ ] config.py
- [ ] server.py（セッション管理 + WebSocket エンドポイント）
- [ ] live/relay.py（Gemini Live API 中継）
- [ ] rest/router.py（REST TTS）
- [ ] Dockerfile
- [ ] cloudbuild.yaml
- [ ] prompts/ ディレクトリ

### フロントエンド (src/)
- [ ] core-controller.ts: LiveAPI WebSocket 接続
- [ ] core-controller.ts: sendMessage() を WebSocket 経由に変更
- [ ] core-controller.ts: shop_data 受信時の REST TTS 切替
- [ ] core-controller.ts: 不要機能の削除（preGeneratedAcks, fallback等）
- [ ] chat-controller.ts: 最小限の修正
- [ ] concierge-controller.ts: 最小限の修正
- [ ] astro.config.mjs: WebSocket プロキシ設定の追加

### デプロイ設定
- [ ] vercel.json: API リライト設定
- [ ] .env.example: 環境変数テンプレート更新
