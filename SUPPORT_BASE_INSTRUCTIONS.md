# support-base バックエンド修正指示書

> この文書は gourmet-sp2 リポジトリから生成された、support-base バックエンドへの修正指示です。
> 新しい Claude Code セッションで support-base を開き、この指示に従って修正を適用してください。

## 背景

gourmet-sp2 フロントエンドを **Live API（WebSocket）一本化** に改修済み。
バックエンド（support-base）側にも対応する修正が必要。

### アーキテクチャ方針
- **Live API（WebSocket）がメイン経路** — 起動時からリアルタイム音声会話
- **REST API はお店の説明時のみ** — 検索後のテキストチャット・TTS・STT
- **REST フォールバック不要** — Live API が動かなければアプリの意味がない

---

## 修正対象: 4ファイル

### 1. `cloudbuild.yaml` — Cloud Run WebSocket 対応

**問題**: リージョンが `asia-northeast1` だが、実際のサービスは `us-central1` で稼働。
WebSocket に必要な `--session-affinity` が未設定。

**修正内容**:

```yaml
# 変更前
substitutions:
  _SERVICE_NAME: support-base
  _REGION: asia-northeast1    # ← ここを修正

# 変更後
substitutions:
  _SERVICE_NAME: support-base
  _REGION: us-central1        # ← 実際のデプロイ先に合わせる
```

```yaml
# '--allow-unauthenticated' の後に3行追加:
      - '--allow-unauthenticated'
      - '--session-affinity'       # ← WebSocket接続を同一インスタンスに固定（必須）
      - '--timeout=3600'           # ← WebSocket長時間接続に対応（1時間）
      - '--min-instances=1'        # ← コールドスタート防止
```

---

### 2. `support_base/server.py` — end_session エンドポイント修正

**問題**: `end_session` の `session_id` パラメータが FastAPI に query parameter として解釈され、
JSON body で送信すると 422 Validation Error になる。

**修正内容**:

`SessionEndResponse` クラスの**前**に以下を追加:

```python
class SessionEndRequest(BaseModel):
    session_id: str
```

`end_session` 関数のシグネチャと内部を変更:

```python
# 変更前
@app.post("/api/v2/session/end", response_model=SessionEndResponse)
async def end_session(session_id: str):
    """セッション終了"""
    ended = session_manager.end_session(session_id)
    if not ended:
        raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")
    return SessionEndResponse(session_id=session_id, ended=True)

# 変更後
@app.post("/api/v2/session/end", response_model=SessionEndResponse)
async def end_session(req: SessionEndRequest):
    """セッション終了"""
    ended = session_manager.end_session(req.session_id)
    if not ended:
        raise HTTPException(status_code=404, detail=f"Session not found: {req.session_id}")
    return SessionEndResponse(session_id=req.session_id, ended=True)
```

---

### 3. `support_base/live/relay.py` — tool_call ハンドリング TODO

**問題**: Gemini Live API が Function Calling（レストラン検索）を返した場合、
現状では無視されてスキップされる。

**修正内容**:

`_recv_from_gemini` メソッド内の `if not sc:` ブロックを変更:

```python
# 変更前
                sc = response.server_content
                if not sc:
                    # tool_call 等の処理 (将来拡張)
                    continue

# 変更後
                sc = response.server_content
                if not sc:
                    # TODO: tool_call ハンドリング未実装
                    # Gemini がレストラン検索等の Function Calling を返す場合、
                    # ここで response.tool_call を処理し、結果を Gemini に返す必要がある。
                    # 現状: Live API でお店検索は動作しない（REST /api/v2/rest/chat のみ対応）
                    if hasattr(response, 'tool_call') and response.tool_call:
                        logger.warning(
                            f"[LiveRelay] Tool call received but not implemented: "
                            f"{response.tool_call}"
                        )
                    continue
```

---

### 4. `support_base/rest/router.py` — mode 正規化 + セッション自動初期化

**問題1**: フロントエンドは `mode: "gourmet"` を送信するが、REST 内部ロジック（support_core.py）は
`"chat"` を期待している。

**問題2**: Live API セッション（SessionManager 管理）の session_id で REST chat endpoint を叩くと
SupportSession（_SESSION_CACHE 管理）に存在しないため 404 エラーになる。

**修正内容**:

#### 4a. `_normalize_mode` 関数を追加（router 定義の直後）

```python
router = APIRouter(prefix="/api/v2/rest", tags=["REST API"])


def _normalize_mode(mode: str) -> str:
    """Live API mode → REST mode に正規化 ('gourmet' → 'chat')"""
    if mode == "gourmet":
        return "chat"
    return mode
```

#### 4b. Pydantic モデルのデフォルト値を変更

```python
class RestSessionStartRequest(BaseModel):
    user_info: dict = {}
    language: str = "ja"
    mode: str = "gourmet"  # "gourmet"(旧"chat") or "concierge"  ← "chat" から変更

class ChatRequest(BaseModel):
    session_id: str
    message: str
    stage: str = "conversation"
    language: str = "ja"
    mode: str = "gourmet"  # ← "chat" から変更
```

#### 4c. `rest_start_session` で mode 正規化を適用

```python
    try:
        # 1. セッション初期化（mode正規化: gourmet→chat）
        rest_mode = _normalize_mode(req.mode)
        session = SupportSession()
        session.initialize(req.user_info, language=req.language, mode=rest_mode)
```

#### 4d. `rest_chat` でセッション自動初期化 + mode 正規化

```python
    try:
        session = SupportSession(req.session_id)
        session_data = session.get_data()

        if not session_data:
            # Live API セッションからの REST チャット要求: 自動初期化
            # (Live API は SessionManager、REST は SupportSession で別管理のため)
            rest_mode = _normalize_mode(req.mode)
            logger.info(
                f"[REST] Auto-creating SupportSession for Live API session: "
                f"{req.session_id}, mode={rest_mode}"
            )
            session.initialize({}, language=req.language, mode=rest_mode)
            session_data = session.get_data()

        # 1. 状態確定（mode正規化: gourmet→chat）
        rest_mode = _normalize_mode(req.mode)
        session.update_language(req.language)
        session.update_mode(rest_mode)
```

---

## パッチファイル

上記の変更はパッチファイルとしても利用可能です:
`support-base-fixes.patch`（gourmet-sp2 リポジトリのルートに同梱）

適用方法:
```bash
cd /path/to/support-base
git apply /path/to/gourmet-sp2/support-base-fixes.patch
```

---

## デプロイ後の確認

修正適用＆デプロイ後、以下を確認:

1. **WebSocket 接続**: `wss://support-base-xxx.us-central1.run.app/api/v2/live/{session_id}` が切断されないこと
2. **REST chat**: Live API session_id で `/api/v2/rest/chat` を叩いて 404 にならないこと
3. **session/end**: JSON body `{"session_id": "..."}` で 422 にならないこと

---

## 今後の課題（この指示書の範囲外）

- `relay.py`: tool_call 実装（Live API 経由でのレストラン検索）
- `api_integrations.py`: `requests.get()` → `httpx.AsyncClient`（async 化）
- `support_core.py`: 38KB モノリス分割
