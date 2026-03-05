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

**relay.py のソースコード確認済み。** 以下の流れで問題が発生している:

1. `handle_client_ws()` (L85-121) に reconnect while ループがある
2. `_run_gemini_session()` (L147-150) で `gemini_client.aio.live.connect()` を呼ぶ
3. 接続が例外を投げると `reconnect_mgr.is_retriable_error()` (L94-106) で判定
4. retriable なら `{"type": "reconnecting", "reason": "error"}` を送信してループ継続
5. 最終的に上限なく回り続け、Cloud Run のタイムアウトで WebSocket 自体が 1006 で切断

**最も疑わしい原因: Gemini モデル名の期限切れ**

```python
# settings.py (Line 11)
LIVE_API_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"
```

このモデルは **2025年12月のプレビュー版** です。2026年3月現在、期限切れまたは廃止されている可能性が高い。
最新の安定モデル名に更新が必要:
- `gemini-2.0-flash-live-001`（安定版）
- `gemini-2.5-flash-preview-native-audio-dialog`（最新プレビュー）
- Google AI Studio で利用可能なモデル一覧を確認してください

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
| **Gemini モデル名が期限切れ** | `settings.py` L11: `LIVE_API_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"` — **2025年12月のプレビュー版。2026年3月現在、廃止されている可能性大** |
| **Gemini API キーは有効か** | `echo $GOOGLE_API_KEY` / Cloud Run 環境変数を確認 |
| **Gemini Live API のリージョン制限** | US リージョン（us-central1）からのアクセスが許可されているか |
| **API クォータ超過** | Google Cloud Console → Gemini API → Quotas を確認 |
| **reconnect ループに上限がない** | `handle_client_ws()` (L85-121) の while ループに max_retries がない → 無限リトライ |
| **session_manager.get_session() の返り値** | Gemini 設定（system_instruction, tools 等）が正しく渡されているか |

#### 修正1: Gemini モデル名を更新（最優先）

```python
# settings.py (Line 11)

# 変更前
LIVE_API_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"

# 変更後（以下のいずれか、Google AI Studio で利用可能なものを選択）
LIVE_API_MODEL = "gemini-2.0-flash-live-001"                     # 安定版
# または
LIVE_API_MODEL = "gemini-2.5-flash-preview-native-audio-dialog"  # 最新プレビュー
```

**確認方法**: Python で直接テスト

```python
import google.genai as genai
client = genai.Client(api_key="YOUR_KEY")

# 利用可能な Live API モデルを確認
for m in client.models.list():
    if "live" in m.name.lower() or "native-audio" in m.name.lower():
        print(m.name)
```

#### 修正2: reconnect ループに上限を設定

```python
# relay.py handle_client_ws() (L85-121)

# 変更前（推定: while self.is_running の無限ループ）
while self.is_running:
    try:
        await self._run_gemini_session(websocket)
    except Exception as e:
        if reconnect_mgr.is_retriable_error(e):
            await self._send_json(websocket, {"type": "reconnecting", "reason": "error"})
            continue  # ← 無限リトライ
        ...

# 変更後: リトライ上限を追加
MAX_ERROR_RETRIES = 3
error_retries = 0
while self.is_running:
    try:
        await self._run_gemini_session(websocket)
        error_retries = 0  # 成功時リセット
    except Exception as e:
        if reconnect_mgr.is_retriable_error(e) and error_retries < MAX_ERROR_RETRIES:
            error_retries += 1
            logger.warning(f"[LiveRelay] Retriable error ({error_retries}/{MAX_ERROR_RETRIES}): {e}")
            await self._send_json(websocket, {"type": "reconnecting", "reason": str(e)})
            await asyncio.sleep(2 ** (error_retries - 1))  # 指数バックオフ
            continue
        # 上限超過 or 非リトライエラー
        logger.error(f"[LiveRelay] Fatal error: {e}", exc_info=True)
        await self._send_json(websocket, {"type": "error", "message": str(e)[:200]})
        break
```

#### 修正3: reconnecting の reason にエラー詳細を含める

現在 `reason: "error"` のみでフロントエンドからは原因が分からない。

```python
# 変更前
await self._send_json(websocket, {"type": "reconnecting", "reason": "error"})

# 変更後
await self._send_json(websocket, {"type": "reconnecting", "reason": str(e)[:200]})
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

## デプロイ結果 (2026-03-05 01:42 UTC)

### デプロイ済み修正

| # | 修正 | ファイル | 内容 | ステータス |
|---|------|---------|------|-----------|
| **1** | reconnect ループ上限 | `relay.py` | `MAX_GEMINI_RETRIES = 3` — エラー起因リトライを最大3回で打ち切り | ✅ デプロイ済み |
| **2** | WebSocket 正常切断 | `relay.py` | finally ブロックで `websocket.close(code=1000)` を確実に実行 | ✅ デプロイ済み |
| **3** | REST エラー詳細返却 | `router.py` | 500 → 200 + `"DEBUG: {ErrorType}: {message}"` で根本原因を返す | ✅ デプロイ済み |
| **4** | ログ強化 | `relay.py` | Gemini接続開始ログ、exc_info=True、TaskGroup例外詳細 | ✅ デプロイ済み |

**デプロイ情報:**
- Build ID: `829cc014-aa63-48c6-a093-a91499006967`
- Duration: 3M12S
- Status: SUCCESS
- URL: `https://support-base-hhasiuut7q-uc.a.run.app`

### ⚠️ 未対応: モデル名の更新

**`settings.py` の `LIVE_API_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"` は変更されていない可能性あり。**

これは依頼1・2 の**根本原因**である可能性が最も高い。リトライ上限を設けたことで無限ループは防げるが、Gemini 接続自体が失敗し続けるならエラー終了になるだけ。

**次のアクション:**
1. デプロイ後のテストを実行して reconnecting が発生するか確認
2. 発生する場合 → モデル名を最新版に更新してデプロイ
3. REST chat のレスポンスに `DEBUG:` プレフィックスが表示されたら、エラー内容を確認

---

## まとめ

| # | 依頼 | 根本原因（推定） | 対応状況 |
|---|------|-----------------|---------|
| **1** | Gemini Live API 接続不安定 | **モデル名期限切れ** + reconnect 無限ループ | ループ上限 ✅ / **モデル名更新 ⚠️ 未確認** |
| **2** | WebSocket 1006 切断 | 依頼1 + close frame 未送信 | close frame ✅ / **根本原因は依頼1** |
| **3** | REST chat 内部エラー | 未特定 | DEBUG レスポンス ✅ → **テストで原因判明予定** |

**最優先: テスト実行 → 結果に応じてモデル名更新。**
