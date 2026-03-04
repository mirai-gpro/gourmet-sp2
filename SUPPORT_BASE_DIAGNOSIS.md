# support-base 接続テスト診断結果 & 修正指示書

> **実施日**: 2026-03-04
> **実施元**: gourmet-sp2 フロントエンドセッション
> **対象**: `support-base-32596857330.us-central1.run.app`
> **目的**: デプロイ済みバックエンドの全エンドポイント動作確認

---

## 1. テスト結果サマリ

| # | エンドポイント | メソッド | 結果 | 備考 |
|---|---|---|---|---|
| 1 | `/api/v2/health` | GET | **OK** | `{"status":"healthy","active_sessions":6}` |
| 2 | `/api/v2/modes` | GET | **OK** | `gourmet` モード返却 |
| 3 | `/api/v2/session/start` | POST | **OK** | session_id, ws_url, greeting 正常返却 |
| 4 | `/api/v2/session/end` | POST | **OK** | `{"session_id":"..."}` body で正常終了（修正済み） |
| 5 | `/api/v2/rest/session/start` | POST | **OK** | REST用セッション正常作成 |
| 6 | `/api/v2/rest/chat` | POST | **NG** | `"エラーが発生しました"` — 内部エラー |
| 7 | `WS /api/v2/live/{session_id}` | WebSocket | **NG** | HTTP 403 — ルート未登録 |

**致命的問題が2件**: REST chat と WebSocket の両方が動作しない状態。

---

## 2. 問題A: WebSocket 403（最重要）

### 症状

```
wss://support-base-xxx.run.app/api/v2/live/{session_id}
→ HTTP 403 (empty body, content-length: 0)
```

**全パスで一律 403**:
```
/api/v2/live/sess_xxxxx  → 403
/api/v2/health           → 403  (REST では 200)
/nonexistent/path        → 403
```

### 原因

**Starlette/FastAPI は、WebSocket ルートが登録されていないパスへの WebSocket Upgrade リクエストに対して 404 ではなく 403 を返す仕様**。

つまり `/api/v2/live/{session_id}` の **WebSocket ルートが FastAPI app に登録されていない**。

### 確認手順

```bash
# server.py で以下を検索:
grep -n "websocket\|WebSocket\|live" support_base/server.py
```

以下のいずれかのパターンが存在するはず:

```python
# パターン1: 直接登録
@app.websocket("/api/v2/live/{session_id}")
async def websocket_live(websocket: WebSocket, session_id: str):
    ...

# パターン2: relay.py 内でルーター定義
# relay.py
router = APIRouter()

@router.websocket("/api/v2/live/{session_id}")
async def websocket_live(...):
    ...

# server.py で include
app.include_router(live_router)
```

### 修正方法

**`server.py` に WebSocket ルートが無い場合、追加が必要。**

`relay.py` に `LiveRelay` クラスは存在する（パッチで確認済み）ので、それを呼び出す WebSocket エンドポイントを `server.py` に追加する:

```python
from fastapi import WebSocket, WebSocketDisconnect
from support_base.live.relay import LiveRelay

@app.websocket("/api/v2/live/{session_id}")
async def websocket_live(websocket: WebSocket, session_id: str):
    """Live API WebSocket エンドポイント"""
    # 1. セッション検証
    session = session_manager.get_session(session_id)
    if not session:
        await websocket.close(code=4004, reason="Session not found")
        return

    # 2. WebSocket 受け入れ
    await websocket.accept()

    # 3. LiveRelay に委譲
    try:
        relay = LiveRelay(session_id, websocket, session_manager)
        await relay.run()
    except WebSocketDisconnect:
        logger.info(f"[WS] Client disconnected: {session_id}")
    except Exception as e:
        logger.error(f"[WS] Error: {session_id}: {e}")
        await websocket.close(code=1011, reason=str(e))
```

> **注意**: `LiveRelay` のコンストラクタ引数は実際のコードに合わせて調整してください。
> `relay.py` の既存コードを確認し、正しい引数を渡すこと。

### 検証方法

```python
# Python で検証
import asyncio, websockets, json, urllib.request

async def test():
    req = urllib.request.Request(
        'https://support-base-32596857330.us-central1.run.app/api/v2/session/start',
        data=json.dumps({"mode":"gourmet","language":"ja"}).encode(),
        headers={"Content-Type": "application/json"}
    )
    sid = json.loads(urllib.request.urlopen(req).read())["session_id"]
    uri = f"wss://support-base-32596857330.us-central1.run.app/api/v2/live/{sid}"
    async with websockets.connect(uri, open_timeout=10) as ws:
        print("CONNECTED!")  # ← これが出れば成功
        await ws.close()

asyncio.run(test())
```

**期待結果**: `CONNECTED!` が表示される（403 が出なくなる）

---

## 3. 問題B: REST chat 内部エラー

### 症状

```bash
# Live API セッションでも REST セッションでも同じエラー
POST /api/v2/rest/chat
  {"session_id":"sess_xxx","message":"こんにちは","language":"ja","mode":"gourmet"}
→ {"response":"エラーが発生しました。もう一度お試しください。","shops":[],...}
```

**REST セッション（`/api/v2/rest/session/start` で作成）でも同じ**なので、
セッション不在の問題（SUPPORT_BASE_INSTRUCTIONS.md #4d）ではなく、
**chat 処理自体の内部エラー**。

### 確認手順

```bash
# 1. Cloud Run ログで実際のエラーを確認
gcloud run services logs read support-base \
  --region=us-central1 \
  --limit=50 \
  | grep -A5 "ERROR\|Traceback\|rest_chat\|Exception"

# 2. rest/router.py の rest_chat() 内の try/except を確認
# "エラーが発生しました" を返している箇所を特定
grep -n "エラーが発生しました" support_base/rest/router.py
```

### 想定される原因（優先度順）

1. **Gemini API キー / モデル設定エラー** — `GOOGLE_API_KEY` や `GEMINI_MODEL` 環境変数が未設定・失効
2. **mode 不一致** — `"gourmet"` が内部で `"chat"` に変換されていない（SUPPORT_BASE_INSTRUCTIONS.md #4 の修正が未適用）
3. **support_core.py 内部エラー** — `SupportAssistant.process_message()` が例外を投げている
4. **外部 API 接続エラー** — Tabelog API/検索API 等への接続失敗

### 修正方法

まず Cloud Run ログで**実際のスタックトレース**を取得してください。
エラーメッセージ `"エラーが発生しました"` はcatchオール文なので、
根本原因はログでしか特定できません。

```bash
# ログ確認コマンド
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="support-base" AND severity>=ERROR' \
  --limit=20 --format="table(timestamp,textPayload)"
```

**mode 正規化パッチが未適用の場合**は、SUPPORT_BASE_INSTRUCTIONS.md セクション4 の修正を適用:
- `_normalize_mode()` 関数の追加
- `rest_start_session` / `rest_chat` での呼び出し

---

## 4. 正常動作しているエンドポイント（参考）

### session/start レスポンス例
```json
{
  "session_id": "sess_ae689fd4b24b",
  "mode": "gourmet",
  "language": "ja",
  "dialogue_type": "live",
  "greeting": "いらっしゃいませ。グルメコンシェルジュです。...",
  "ws_url": "/api/v2/live/sess_ae689fd4b24b"
}
```
- `ws_url` が**相対パス**で返却される → フロントエンドで `backendUrl` を付与して絶対URL化済み
- `greeting` が正常に返却されている → Gemini API 自体は稼働中

### session/end レスポンス例
```json
{"session_id": "sess_xxx", "ended": true}
```
- JSON body `{"session_id": "..."}` での送信が正常動作 → `SessionEndRequest` 修正は適用済み

### health レスポンス例
```json
{"status": "healthy", "modes": [{"name": "gourmet", ...}], "a2e_available": false, "active_sessions": 6}
```

---

## 5. 修正の優先順位

| 優先度 | 問題 | 影響 | 作業量 |
|---|---|---|---|
| **P0** | WebSocket ルート未登録 | Live API 全機能不可（音声会話できない） | server.py に10-20行追加 |
| **P0** | REST chat 内部エラー | お店検索・テキスト会話不可 | ログ確認 → 原因特定 → 修正 |

**両方 P0**: WebSocket が動かないと音声会話不可、REST chat が動かないとお店検索不可。
フロントエンドは Live API（WS）+ REST chat（検索時のみ）の二本立てなので、両方必要。

---

## 6. デプロイ後の再検証チェックリスト

修正・再デプロイ後、以下を順に確認:

```bash
# 1. Health check
curl -s https://support-base-32596857330.us-central1.run.app/api/v2/health

# 2. Session start
curl -s -X POST https://support-base-32596857330.us-central1.run.app/api/v2/session/start \
  -H "Content-Type: application/json" \
  -d '{"mode":"gourmet","language":"ja"}'
# → session_id, ws_url を確認

# 3. WebSocket 接続 (Python)
python3 -c "
import asyncio, websockets, json, urllib.request
async def t():
    r = urllib.request.urlopen(urllib.request.Request(
        'https://support-base-32596857330.us-central1.run.app/api/v2/session/start',
        json.dumps({'mode':'gourmet','language':'ja'}).encode(),
        {'Content-Type':'application/json'}))
    sid = json.loads(r.read())['session_id']
    async with websockets.connect(f'wss://support-base-32596857330.us-central1.run.app/api/v2/live/{sid}') as ws:
        print(f'WS OK: {sid}')
asyncio.run(t())
"
# → "WS OK: sess_xxx" が出れば成功

# 4. REST chat
SID=<上で取得したsession_id>
curl -s -X POST https://support-base-32596857330.us-central1.run.app/api/v2/rest/chat \
  -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$SID\",\"message\":\"新宿でイタリアン\",\"language\":\"ja\",\"mode\":\"gourmet\"}"
# → "response" にAI応答テキスト、"shops" に検索結果が返ること

# 5. Session end
curl -s -X POST https://support-base-32596857330.us-central1.run.app/api/v2/session/end \
  -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$SID\"}"
# → {"session_id":"...","ended":true}
```

---

## 7. フロントエンド側の関連コード（参考）

support-base 修正時に参考になるフロントエンドの通信フロー:

### WebSocket 接続フロー
```
1. POST /api/v2/session/start → { session_id, ws_url: "/api/v2/live/sess_xxx" }
2. ws_url を絶対URL化: wss://support-base-xxx.run.app/api/v2/live/sess_xxx
3. new WebSocket(absoluteUrl)
4. 双方向: { type: "audio"|"text"|"stop", data: "..." }
```

### REST chat フロー（お店検索時のみ）
```
1. POST /api/v2/rest/chat
   { session_id, message, stage: "conversation", language: "ja", mode: "gourmet" }
2. → { response, audio?, expression?, shops[], should_confirm, is_followup }
```

### REST TTS フロー
```
1. POST /api/v2/rest/tts/synthesize
   { text, language_code: "ja-JP", voice_name: "ja-JP-Chirp3-HD-Leda", session_id }
2. → { audio: "base64...", expression?: {...} }
```
