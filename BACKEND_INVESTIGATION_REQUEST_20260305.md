# support-base バックエンド調査・修正依頼書（第3版）

> **日付**: 2026-03-05
> **発行元**: gourmet-sp2 フロントエンドチーム
> **対象**: support-base バックエンド（Cloud Run: `support-base-hhasiuut7q-uc.a.run.app`）
> **緊急度**: **P0（全機能停止）** — 両モード（gourmet / concierge）で音声認識が動作しない

---

## 経緯

| 日付 | 文書 | 状況 |
|------|------|------|
| 03-04 | `SUPPORT_BASE_INSTRUCTIONS.md` | 初回パッチ 4件を依頼（cloudbuild / server.py / relay.py / router.py） |
| 03-04 | `SUPPORT_BASE_REINVESTIGATION.md` | パッチ適用後も WS 403 + REST chat エラーが未解決 |
| **03-05** | **本書** | フロントエンドテストで WS 接続→即切断（code=1006）を確認。新たな問題を追加 |

---

## 現在のフロントエンドログ（再現手順: マイクボタン押下）

```
[LiveWSClient] Connected: wss://support-base-hhasiuut7q-uc.a.run.app/api/v2/live/sess_xxx
[LiveAudioIO] Mic started (48kHz → 16kHz)
[Core] Reconnecting: error    ← ★ 9回連続
[Core] Reconnecting: error
[Core] Reconnecting: error
...
[Core] Live API connection: false
[LiveWSClient] Closed: code=1006, reason=
```

**状況まとめ**:
- WebSocket 接続自体は **成功する**（HTTP 101 → Connected）
- サーバーから `{ "type": "reconnecting", "reason": "error" }` が **9回連続** で送信される
- その後 WebSocket が **code=1006**（異常切断）で閉じる
- **音声データは送信されるが、サーバーが処理できていない**

---

## 依頼事項: 3件

### 【依頼1】Gemini Live API 接続の不安定性調査・修正（P0）

#### 問題

WebSocket 接続成功後、サーバー側の Gemini Live API セッションが確立できず、`reconnecting: error` を繰り返して最終的に切断される。

#### 推定原因

`relay.py` の `_recv_from_gemini` または Gemini セッション確立処理で例外が発生し、内部の reconnect ループが回り続けている。

#### 調査手順

```bash
# ===== Step 1: Cloud Run ログで Gemini 接続エラーを確認 =====
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="support-base" AND severity>=WARNING' \
  --limit=50 \
  --format="table(timestamp,textPayload)" \
  --project=ai-meet-486502

# ===== Step 2: relay.py の reconnect ログを検索 =====
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="support-base" AND textPayload=~"reconnect|LiveRelay|gemini|genai"' \
  --limit=30 \
  --format=json \
  --project=ai-meet-486502

# ===== Step 3: relay.py のソースで reconnecting を送信している箇所を確認 =====
grep -n "reconnecting\|reconnect" support_base/live/relay.py

# ===== Step 4: Gemini Live API の初期化コードを確認 =====
grep -n "genai\|GenerativeModel\|LiveConnect\|live\|BidiGenerateContent" support_base/live/relay.py
```

#### 確認ポイント

| チェック項目 | 確認方法 |
|---|---|
| **Gemini API キーは有効か** | `echo $GOOGLE_API_KEY` / Cloud Run 環境変数を確認 |
| **Gemini モデル名は正しいか** | `relay.py` 内のモデル名が `gemini-2.0-flash-live-001` 等の存在するモデルか |
| **Gemini Live API のリージョン制限** | US リージョン（us-central1）からのアクセスが許可されているか |
| **API クォータ超過** | Google Cloud Console → Gemini API → Quotas を確認 |
| **relay.py の reconnect ループ** | 例外発生 → reconnect → 例外 の無限ループになっていないか |
| **session_manager.get_session() の返り値** | Gemini 設定（system_instruction, tools 等）が正しく渡されているか |

#### 想定される修正

```python
# relay.py の Gemini 接続部分（推定）

# NG パターン: 例外を握りつぶして再接続ループ
async def _connect_gemini(self):
    while True:
        try:
            self.gemini_session = await genai.LiveConnect(...)
            break
        except Exception as e:
            await self._send_to_client({"type": "reconnecting", "reason": "error"})
            await asyncio.sleep(1)  # ← これが 9回回ってタイムアウト

# OK パターン: 例外の種類を判別、上限設定
async def _connect_gemini(self):
    max_retries = 3
    for attempt in range(max_retries):
        try:
            self.gemini_session = await genai.LiveConnect(...)
            break
        except google.api_core.exceptions.ResourceExhausted as e:
            logger.error(f"[LiveRelay] Gemini quota exceeded: {e}")
            await self._send_to_client({"type": "error", "message": "API quota exceeded"})
            return  # 再試行しても無駄
        except Exception as e:
            logger.error(f"[LiveRelay] Gemini connect attempt {attempt+1}/{max_retries}: {e}", exc_info=True)
            await self._send_to_client({"type": "reconnecting", "reason": str(e)})
            if attempt < max_retries - 1:
                await asyncio.sleep(2 ** attempt)
    else:
        await self._send_to_client({"type": "error", "message": "Failed to connect to Gemini after retries"})
        return
```

---

### 【依頼2】WebSocket 1006 異常切断の原因特定（P0）

#### 問題

WebSocket が `code=1006`（Close frame なしの異常切断）で閉じる。これは以下のいずれかを意味する:

1. **サーバープロセスがクラッシュ** — 未処理例外で asyncio task が死亡
2. **Cloud Run がコネクションを切断** — タイムアウト or インスタンス再起動
3. **relay.py が正常な close frame を送らずに終了**

#### 調査手順

```bash
# ===== Cloud Run インスタンスの状態を確認 =====
gcloud run services describe support-base --region=us-central1 \
  --format="yaml(spec.template.spec.containers[0].resources,spec.template.metadata.annotations)"

# ===== 未処理例外の確認 =====
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="support-base" AND (textPayload=~"Traceback|Exception|Error" OR severity=ERROR)' \
  --limit=30 \
  --format="table(timestamp,textPayload)" \
  --project=ai-meet-486502

# ===== relay.py の WebSocket close 処理を確認 =====
grep -n "close\|1006\|1011\|1000\|finally" support_base/live/relay.py
```

#### 確認ポイント

| チェック項目 | 確認方法 |
|---|---|
| **Cloud Run の request timeout** | `--timeout` が十分か（WebSocket には 3600 推奨） |
| **session-affinity** | `gcloud run services describe` で確認 |
| **relay.py の finally ブロック** | Gemini 切断時に `websocket.close()` を呼んでいるか |
| **asyncio task の例外ハンドリング** | `asyncio.create_task()` で起動した task の例外が捕捉されているか |

---

### 【依頼3】REST chat 内部エラー（P0 — 前回からの継続）

前回依頼（`SUPPORT_BASE_REINVESTIGATION.md` 依頼2）と同じ。

```bash
POST /api/v2/rest/chat
→ {"response":"エラーが発生しました。もう一度お試しください。","shops":[],...}
```

REST 専用セッションでも同じエラーのため、**セッション不在ではなく chat 処理自体の内部エラー**。

#### 追加の調査ポイント

前回の調査で確認できなかった場合、以下を試す:

```python
# router.py の rest_chat 関数内: 一時的にエラー詳細を返す
except Exception as e:
    import traceback
    tb = traceback.format_exc()
    logger.error(f"[REST] Chat error: {req.session_id}: {tb}")
    return ChatResponse(
        response=f"DEBUG: {type(e).__name__}: {str(e)[:300]}",
        summary=None, shops=[], should_confirm=False, is_followup=False
    )
```

**デプロイ → エラー再現 → ログ確認 → 根本原因特定** のサイクルを回してください。

---

## フロントエンド側の対応状況

フロントエンドでは以下の対策を実施済み:

| 修正 | ファイル | 内容 |
|------|---------|------|
| WebSocket 自動再接続 | `live-ws-client.ts` | 異常切断時に指数バックオフ（1s〜16s）で最大5回自動再接続 |
| マイク自動復帰 | `core-controller.ts` | WebSocket 再接続成功時にマイクストリーミングを自動再開 |
| is_final 対応 | `LAMAvatar.astro` + `concierge-controller.ts` | リップシンクストリーム終了判定の改善 |

**これらはバックエンドの根本問題が解決されれば正常に機能する。** バックエンド側の Gemini Live API 接続が安定すれば、フロントエンドは変更なしで動作する見込み。

---

## 修正完了後のテスト

### 最小テスト（WebSocket 音声通話）

```bash
python3 -c "
import asyncio, websockets, json, urllib.request, base64, struct, time

async def test():
    # 1. セッション作成
    req = urllib.request.Request(
        'https://support-base-hhasiuut7q-uc.a.run.app/api/v2/session/start',
        data=json.dumps({'mode':'gourmet','language':'ja','dialogue_type':'live'}).encode(),
        headers={'Content-Type': 'application/json'})
    data = json.loads(urllib.request.urlopen(req).read())
    sid = data['session_id']
    print(f'Session: {sid}')

    # 2. WebSocket 接続
    uri = f'wss://support-base-hhasiuut7q-uc.a.run.app/api/v2/live/{sid}'
    async with websockets.connect(uri, open_timeout=10) as ws:
        print('PASS: WebSocket connected')

        # 3. 10秒間メッセージ受信（reconnecting が来ないことを確認）
        reconnect_count = 0
        start = time.time()
        while time.time() - start < 10:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=2)
                data = json.loads(msg)
                print(f'  Received: type={data[\"type\"]}', end='')
                if data['type'] == 'reconnecting':
                    reconnect_count += 1
                    print(f' reason={data.get(\"reason\")}')
                elif data['type'] == 'transcription':
                    print(f' role={data.get(\"role\")} text={data.get(\"text\",\"\")[:50]}')
                else:
                    print()
            except asyncio.TimeoutError:
                print('  (waiting...)')

        # 4. テキスト送信テスト
        await ws.send(json.dumps({'type': 'text', 'data': 'こんにちは'}))
        print('Sent text message')
        try:
            msg = await asyncio.wait_for(ws.recv(), timeout=15)
            data = json.loads(msg)
            print(f'PASS: Response type={data[\"type\"]}')
        except asyncio.TimeoutError:
            print('FAIL: No response to text message in 15s')

        await ws.close()

        if reconnect_count > 0:
            print(f'FAIL: Got {reconnect_count} reconnecting events')
        else:
            print('PASS: No reconnecting events (Gemini session stable)')

asyncio.run(test())
"
```

**合格基準**:
- `PASS: WebSocket connected` — WebSocket 接続成功
- `PASS: No reconnecting events` — Gemini セッションが安定
- `PASS: Response type=...` — テキスト送信に対して応答あり

### REST chat テスト

```bash
SID=$(curl -s -X POST https://support-base-hhasiuut7q-uc.a.run.app/api/v2/rest/chat \
  -H "Content-Type: application/json" \
  -d '{"mode":"gourmet","language":"ja"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))")

curl -s -X POST https://support-base-hhasiuut7q-uc.a.run.app/api/v2/rest/chat \
  -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$SID\",\"message\":\"新宿でイタリアン\",\"language\":\"ja\",\"mode\":\"gourmet\"}" | python3 -m json.tool

# 期待: "response" にAI応答テキスト、"shops" に検索結果
```

---

## テスト結果報告テンプレート

```
=== support-base 修正テスト結果 (YYYY-MM-DD) ===

Test 1 (Health):           PASS / FAIL — [詳細]
Test 2 (Session Start):    PASS / FAIL — [詳細]
Test 3 (WS Connect):       PASS / FAIL — [詳細]
Test 4 (WS Stability):     PASS / FAIL — reconnecting events: 0 / N回
Test 5 (WS Text Response): PASS / FAIL — [詳細]
Test 6 (REST Chat):        PASS / FAIL — [詳細]

修正内容:
- [修正したファイルと内容]

Cloud Run ログ（エラー）:
- [関連ログを貼付]
```

---

## 補足: アーキテクチャ図

```
┌─────────────────────────────────────────────────────────────┐
│  gourmet-sp2 (Vercel)                                       │
│                                                             │
│  ┌─────────────┐    ┌──────────────────┐                    │
│  │ LAMAvatar   │◄───│ ConciergeCtrl    │                    │
│  │ (3D avatar) │    │ (expression処理) │                    │
│  └─────────────┘    └────────┬─────────┘                    │
│                              │                              │
│  ┌───────────────────────────┴──────────────────────┐       │
│  │ CoreController                                    │       │
│  │  ├─ toggleRecording() → startLiveStream()        │       │
│  │  ├─ on('connection') → auto-resume mic           │       │
│  │  └─ on('reconnecting') → UI更新                  │       │
│  └───────────────────────────┬──────────────────────┘       │
│                              │                              │
│  ┌───────────────────────────┴──────────────────────┐       │
│  │ DialogueManager                                   │       │
│  │  ├─ LiveAudioIO (48kHz→16kHz, PCM→base64)       │       │
│  │  └─ LiveWSClient (auto-reconnect, max 5 retries) │       │
│  └───────────────────────────┬──────────────────────┘       │
│                              │                              │
└──────────────────────────────┼──────────────────────────────┘
                               │ WSS (direct, bypasses Vercel proxy)
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  support-base (Cloud Run: us-central1)                       │
│                                                              │
│  ┌────────────┐     ┌──────────────────────────────────┐     │
│  │ server.py  │────►│ @app.websocket("/api/v2/live/..") │    │
│  │ (FastAPI)  │     └───────────────┬──────────────────┘     │
│  └────────────┘                     │                        │
│                        ┌────────────┴────────────┐           │
│                        │ relay.py (LiveRelay)     │           │
│                        │  ├─ _recv_from_client()  │           │
│                        │  ├─ _recv_from_gemini()  │  ★ ここ  │
│                        │  └─ reconnect logic      │  が問題   │
│                        └────────────┬────────────┘           │
│                                     │                        │
│                        ┌────────────┴────────────┐           │
│                        │ Gemini Live API          │           │
│                        │ (BidiGenerateContent)    │           │
│                        └─────────────────────────┘           │
│                                                              │
│  ┌────────────┐     ┌───────────────────────────┐            │
│  │ rest/      │────►│ router.py → support_core  │  ★ REST   │
│  │ router.py  │     │ → Gemini REST API         │  chat も  │
│  └────────────┘     └───────────────────────────┘  エラー    │
└──────────────────────────────────────────────────────────────┘
```

---

## まとめ

| # | 依頼 | 根本原因（推定） | 必要な対応 |
|---|------|-----------------|-----------|
| **1** | Gemini Live API 接続不安定 | relay.py の Gemini 接続が例外を繰り返している | Cloud Run ログで例外を特定 → 修正 |
| **2** | WebSocket 1006 切断 | Gemini reconnect 失敗後に正常な close frame なしで終了 | relay.py の finally ブロックで `websocket.close()` を確実に実行 |
| **3** | REST chat 内部エラー | 未特定（前回から継続） | ログでスタックトレースを取得 → 根本原因特定 |

**最優先アクション: Cloud Run ログの確認。** フロントエンドからはサーバー内部のエラー内容が見えないため、ログの確認が不可欠です。
