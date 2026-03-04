# support-base 再調査 & 再修正依頼書

> **日付**: 2026-03-04
> **経緯**: 前回パッチ（support-base-fixes.patch）適用 → rev 00003 デプロイ完了 → 再テストで **2件の致命的問題が未解決**
> **前提**: `SUPPORT_BASE_INSTRUCTIONS.md` のパッチ 4件（cloudbuild / server.py / relay.py / router.py）は適用済み

---

## 現状ステータス

| エンドポイント | 結果 | 前回パッチで対応? |
|---|---|---|
| `GET /api/v2/health` | **OK** | — |
| `GET /api/v2/modes` | **OK** | — |
| `POST /api/v2/session/start` | **OK** (greeting・ws_url返却) | — |
| `POST /api/v2/session/end` | **OK** (JSON body対応) | **済** (server.py修正) |
| `POST /api/v2/rest/session/start` | **OK** | — |
| `POST /api/v2/rest/chat` | **NG** — 内部エラー | パッチ対象だったが**直っていない** |
| `WS /api/v2/live/{session_id}` | **NG** — HTTP 403 | **パッチ対象外だった（漏れ）** |

**結論: アプリケーションの主要機能（音声会話・テキストチャット）が両方とも動作しない。**

---

## 依頼事項: 2件

### 【依頼1】WebSocket ルート登録（P0 — 音声会話の全機能が不可）

#### 問題

```
WebSocket wss://support-base-xxx.run.app/api/v2/live/{session_id}
→ HTTP 403 (empty body, content-length: 0)
```

任意のパスで一律 403:
```
/api/v2/live/sess_xxxxx  → 403
/api/v2/health           → 403（REST では 200）
/nonexistent/path        → 403
```

これは **Starlette/FastAPI の仕様**: WebSocket ルートが存在しないパスへの Upgrade リクエストは 404 ではなく **403** を返す。

#### 原因

`server.py` に **`@app.websocket("/api/v2/live/{session_id}")` が登録されていない**。

`relay.py` に `LiveRelay` クラスは存在するが、それを呼び出す WebSocket エンドポイントが未定義。

#### 調査手順

```bash
# 1. server.py の WebSocket 登録状況を確認
grep -n "websocket\|WebSocket\|@app.ws" support_base/server.py

# 2. relay.py のクラス定義・コンストラクタ・run メソッドを確認
grep -n "class LiveRelay\|def __init__\|def run\|async def run" support_base/live/relay.py

# 3. server.py での relay の import 状況を確認
grep -n "relay\|LiveRelay" support_base/server.py

# 4. router の include 状況を確認
grep -n "include_router\|mount" support_base/server.py
```

#### 修正方法

`server.py` に WebSocket エンドポイントを追加する。

**重要: `LiveRelay` のコンストラクタ引数は実際のコードに合わせること。以下はあくまで参考テンプレート。**

```python
# === server.py に追加 ===

from fastapi import WebSocket, WebSocketDisconnect

# もし未 import なら:
# from support_base.live.relay import LiveRelay

@app.websocket("/api/v2/live/{session_id}")
async def websocket_live(websocket: WebSocket, session_id: str):
    """Live API WebSocket エンドポイント"""
    # セッション検証
    session = session_manager.get_session(session_id)
    if not session:
        await websocket.close(code=4004, reason="Session not found")
        return

    await websocket.accept()

    try:
        # ★ LiveRelay のコンストラクタ引数は実際のコードを確認して合わせる
        # 例: LiveRelay(session_id, websocket, session_manager)
        # 例: LiveRelay(session_id=session_id, ws=websocket, config=session["config"])
        relay = LiveRelay(...)  # ← 実際の引数に置き換え
        await relay.run()
    except WebSocketDisconnect:
        logger.info(f"[WS] Client disconnected: {session_id}")
    except Exception as e:
        logger.error(f"[WS] Error in LiveRelay: {session_id}: {e}", exc_info=True)
        try:
            await websocket.close(code=1011, reason="Internal error")
        except Exception:
            pass
```

**もし `relay.py` 内に既にルーター定義がある場合** (`APIRouter` + `@router.websocket(...)`):

```bash
# relay.py に router が定義されているか確認
grep -n "APIRouter\|router\s*=" support_base/live/relay.py
```

→ もしある場合は、`server.py` に `app.include_router(live_router)` を追加するだけで済む。

#### 正しく動作した場合のフロー

```
1. フロントエンド: POST /api/v2/session/start
   → { session_id: "sess_xxx", ws_url: "/api/v2/live/sess_xxx" }

2. フロントエンド: WebSocket wss://backend/api/v2/live/sess_xxx
   → HTTP 101 Switching Protocols（WebSocket接続確立）

3. 双方向通信:
   Client→Server: { "type": "audio", "data": "<base64 PCM 16kHz>" }
   Client→Server: { "type": "text",  "data": "テキスト入力" }
   Server→Client: { "type": "audio", "data": "<base64 PCM 24kHz>" }
   Server→Client: { "type": "transcription", "role": "ai", "text": "..." }
```

---

### 【依頼2】REST chat 内部エラー調査・修正（P0 — お店検索が不可）

#### 問題

```bash
# テストコマンド（Live API セッション）
curl -s -X POST https://support-base-32596857330.us-central1.run.app/api/v2/rest/chat \
  -H "Content-Type: application/json" \
  -d '{"session_id":"sess_ae689fd4b24b","message":"新宿でイタリアン","language":"ja","mode":"gourmet"}'

# レスポンス
{"response":"エラーが発生しました。もう一度お試しください。","summary":null,"shops":[],"should_confirm":false,"is_followup":false}
```

**REST 専用セッション（`/api/v2/rest/session/start` で作成）でも同じエラー** → セッション不在が原因ではない。

**`session/start` の greeting は正常生成されている** → Gemini API 自体は稼働中。

#### 調査手順

```bash
# ===== Step 1: Cloud Run ログでスタックトレースを確認 =====
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="support-base" AND severity>=ERROR' \
  --limit=30 \
  --format="table(timestamp,textPayload)" \
  --project=ai-meet-486502

# 見やすい形式で出す場合:
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="support-base" AND severity>=WARNING' \
  --limit=30 \
  --format=json \
  --project=ai-meet-486502

# ===== Step 2: "エラーが発生しました" を返しているコード箇所を特定 =====
grep -rn "エラーが発生しました" support_base/

# ===== Step 3: rest_chat の try/except 構造を確認 =====
# catch-all で元の例外が握りつぶされている可能性が高い
grep -n -A5 "except.*Exception\|except:" support_base/rest/router.py
```

#### 想定される根本原因（優先度順）

| # | 原因候補 | 確認方法 | 修正方法 |
|---|---|---|---|
| **1** | **mode 不一致**: `"gourmet"` → `"chat"` 変換が効いていない | `grep -n "_normalize_mode\|req.mode" router.py` | パッチ #4 が正しく適用されているか再確認 |
| **2** | **SupportAssistant.process_message() 内部例外** | Cloud Run ログのスタックトレース | 根本原因次第 |
| **3** | **Gemini REST API 呼び出しエラー** | ログで `google.generativeai` エラーを検索 | APIキー・モデル名の確認 |
| **4** | **support_core.py の mode 処理** | `grep -n "mode.*chat\|mode.*gourmet" support_base/support_core.py` | mode マッピング修正 |
| **5** | **外部 API（食べログ等）接続エラー** | `grep -n "requests.get\|httpx\|api_integration" router.py` | URL・APIキーの確認 |

#### デバッグ用：一時的にエラー詳細を返す修正

もしログで原因が特定できない場合、**一時的に**例外メッセージを返すようにすると切り分けが早い:

```python
# rest/router.py の rest_chat 関数内
except Exception as e:
    logger.error(f"[REST] Chat error: {req.session_id}: {e}", exc_info=True)  # ★ exc_info=True でスタックトレースをログ出力
    return ChatResponse(
        response=f"エラーが発生しました: {type(e).__name__}: {str(e)[:200]}",  # ★ 一時的にエラー詳細を返す
        ...
    )
```

---

## 修正完了後のテスト手順

以下を**上から順に**実行し、全て PASS するまでデプロイを繰り返す。

### Test 1: Health

```bash
curl -s https://support-base-32596857330.us-central1.run.app/api/v2/health
# 期待: {"status":"healthy",...}
```

### Test 2: Session Start

```bash
curl -s -X POST https://support-base-32596857330.us-central1.run.app/api/v2/session/start \
  -H "Content-Type: application/json" \
  -d '{"mode":"gourmet","language":"ja"}'
# 期待: { "session_id": "sess_xxx", "ws_url": "/api/v2/live/sess_xxx", "greeting": "..." }
# → session_id をメモ（以降のテストで使用）
```

### Test 3: WebSocket 接続

```bash
pip install websockets  # 未インストールの場合

python3 -c "
import asyncio, websockets, json, urllib.request

async def test():
    # セッション作成
    req = urllib.request.Request(
        'https://support-base-32596857330.us-central1.run.app/api/v2/session/start',
        data=json.dumps({'mode':'gourmet','language':'ja'}).encode(),
        headers={'Content-Type': 'application/json'})
    sid = json.loads(urllib.request.urlopen(req).read())['session_id']

    # WebSocket 接続
    uri = f'wss://support-base-32596857330.us-central1.run.app/api/v2/live/{sid}'
    async with websockets.connect(uri, open_timeout=10) as ws:
        print(f'PASS: WebSocket connected ({sid})')

        # テキスト送信テスト
        await ws.send(json.dumps({'type': 'text', 'data': 'こんにちは'}))
        try:
            msg = await asyncio.wait_for(ws.recv(), timeout=10)
            data = json.loads(msg) if isinstance(msg, str) else msg
            print(f'PASS: Received message type={data.get(\"type\", \"unknown\")}')
        except asyncio.TimeoutError:
            print('WARN: No response in 10s (may need Gemini connection time)')
        await ws.close()
        print('PASS: WebSocket closed cleanly')

asyncio.run(test())
"
# 期待: "PASS: WebSocket connected" が表示される（403 ではなくなる）
```

### Test 4: REST Chat

```bash
# ↑ Test 2 で取得した session_id を使用
SID="sess_xxxxxx"

curl -s -X POST https://support-base-32596857330.us-central1.run.app/api/v2/rest/chat \
  -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$SID\",\"message\":\"新宿でイタリアン\",\"language\":\"ja\",\"mode\":\"gourmet\"}"

# 期待: "response" に具体的なAI応答テキストが返る（"エラーが発生しました" ではない）
```

### Test 5: REST Chat（REST 専用セッション）

```bash
# REST 専用セッション作成
REST_SID=$(curl -s -X POST https://support-base-32596857330.us-central1.run.app/api/v2/rest/session/start \
  -H "Content-Type: application/json" \
  -d '{"mode":"gourmet","language":"ja"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['session_id'])")

echo "REST Session: $REST_SID"

# REST チャット
curl -s -X POST https://support-base-32596857330.us-central1.run.app/api/v2/rest/chat \
  -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$REST_SID\",\"message\":\"渋谷で焼肉\",\"language\":\"ja\",\"mode\":\"gourmet\"}"

# 期待: "response" に具体的なAI応答テキストが返る
```

### Test 6: Session End

```bash
curl -s -X POST https://support-base-32596857330.us-central1.run.app/api/v2/session/end \
  -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$SID\"}"
# 期待: {"session_id":"...","ended":true}
```

---

## テスト結果報告テンプレート

修正・デプロイ後、以下の形式で結果を報告してください:

```
Test 1 (Health):    PASS / FAIL — [詳細]
Test 2 (Session):   PASS / FAIL — [詳細]
Test 3 (WebSocket): PASS / FAIL — [詳細]
Test 4 (REST Chat): PASS / FAIL — [詳細]
Test 5 (REST Only): PASS / FAIL — [詳細]
Test 6 (End):       PASS / FAIL — [詳細]
```

---

## 参考: 前回パッチの適用確認チェックリスト

前回パッチが正しく適用されているかの確認:

```bash
# 1. cloudbuild.yaml: リージョンとフラグ
grep "us-central1" cloudbuild.yaml           # → 見つかるはず
grep "session-affinity" cloudbuild.yaml      # → 見つかるはず

# 2. server.py: SessionEndRequest
grep "SessionEndRequest" support_base/server.py  # → class定義が見つかるはず

# 3. relay.py: tool_call ログ
grep "tool_call received" support_base/live/relay.py  # → 見つかるはず

# 4. router.py: _normalize_mode
grep "_normalize_mode" support_base/rest/router.py    # → def + 呼び出し箇所が見つかるはず
grep "Auto-creating" support_base/rest/router.py      # → ログ文が見つかるはず
```

全て見つかれば前回パッチは適用済み。

---

## 補足: フロントエンドの待ち状態

gourmet-sp2 フロントエンドは**既にデプロイ済み**（Vercel）で、バックエンドの修正を待っている状態:

- **Live API モード**: `wss://support-base-xxx.run.app/api/v2/live/{session_id}` に直接接続
- **REST chat**: `https://support-base-xxx.run.app/api/v2/rest/chat` に直接リクエスト
- **backendUrl**: `https://support-base-32596857330.us-central1.run.app` がハードコード

バックエンド側の2件が修正されれば、フロントエンドは変更なしで動作する見込み。
