# フェーズ1 設計仕様書: REST API → LiveAPI 移行

> **作成日**: 2026-03-08
> **対象リポジトリ**: mirai-gpro/gourmet-sp2
> **ブランチ**: claude/fix-troubleshooting-AvnjQ
> **ベースコード**: gourmet-support (バックエンド安定版) + gourmet-sp (フロントエンド安定版)

---

## 原則7宣言: AIの知識が不足している領域

> 🚨 **この宣言はAI実装者に対するもの**
>
> 以下の技術について、AIは **公式ドキュメントの最新仕様を把握していない** 可能性が高い:
>
> 1. **Gemini LiveAPI** (`google-genai` の `client.aio.live.connect`)
>    - `send_realtime_input(audio=msg)` の正確なシグネチャ
>    - `send_tool_response` の `FunctionResponse` 型の正確なフィールド
>    - `server_content` の属性名 (`input_transcription`, `output_transcription` 等)
>    - `context_window_compression` の設定形式
>    - `automatic_activity_detection` の感度パラメータ
>
> 2. **Audio2Expression (A2E) サービス** (フェーズ2で使用)
>    - Cloud Run上の独自サービス、公開ドキュメントなし
>
> **対策**: 既に本番稼働中の `live_session.py` のコードを **正** とし、
> AIの知識と異なる場合は `live_session.py` のコードを優先する。
> 推測でコードを書き換えてはならない。

---

## 0. 現状整理と目標

### 0-1. 現在の状態

| 項目 | 状態 |
|------|------|
| グルメモード (REST API) | ✅ 安定稼働 |
| コンシェルジュモード (REST API) | ✅ 安定稼働 |
| コンシェルジュモード A2E リップシンク | ✅ 70点の出来で成功 |
| LiveAPI (live_session.py) | ✅ 会議アシスタントで本番稼働 |
| LiveAPI (gourmet-sp2) | ⚠️ 動作するが不安定 |

### 0-2. 目標

**フェーズ1**: グルメモード・コンシェルジュモード共に REST API → LiveAPI に進化
- **例外**: ショップカード紹介セリフ（長文）は REST API + Cloud TTS を維持

### 0-3. やらないこと

> 🚨 **以下は明示的に禁止**
>
> 1. Socket.IO の新規追加・使用（WebSocket Streaming STT は LiveAPI に統合済み）
> 2. Firestore の使用（RAM ベースセッション管理を維持）
> 3. `live_session.py` の LiveAPI 接続パターン（`client.aio.live.connect`）の変更
> 4. AudioWorklet の VAD 追加（Gemini の `automatic_activity_detection` に委任）
> 5. 新しい npm パッケージの追加（現行の Astro + TypeScript 構成を維持）
> 6. プロンプトファイル（prompts/）の変更
> 7. `api_integrations.py` の API 連携ロジックの変更
> 8. `long_term_memory.py` のスキーマ変更

---

## 1. アーキテクチャ概要

### 1-1. 通信フロー図

```
[ブラウザ]                    [Cloud Run]                [Gemini]
    |                              |                        |
    |-- POST /api/session/start -->|                        |
    |<-- session_id, initial_msg --|                        |
    |                              |                        |
    |== WS /ws/live/<session_id> =>|                        |
    |                              |== aio.live.connect ==> |
    |<-- { type: 'live_ready' } ---|                        |
    |                              |                        |
    |-- { type: 'audio_chunk' } -->|-- send_realtime_input->|
    |                              |                        |
    |<-- { type: 'audio' }--------|<-- model_turn.parts ----|
    |<-- { type: 'text' }---------|<-- output_transcription-|
    |<-- { type: 'input_trans' }--|<-- input_transcription--|
    |<-- { type: 'turn_complete'}--|<-- turn_complete -------|
    |                              |                        |
    |   [ショップ検索時]            |                        |
    |<-- { type: 'searching' } ----|<-- tool_call ----------|
    |                              |-- Google Places ------->|
    |                              |-- Gemini REST (desc) -->|
    |                              |-- Cloud TTS ----------->|
    |<-- { type: 'shops' } --------|                        |
    |                              |-- send_tool_response -->|
    |                              |                        |
    |-- { type: 'text_input' } --->|-- send_client_content->|
    |                              |                        |
```

### 1-2. ファイル構成

```
gourmet-sp2/
├── support-base/                    # バックエンド (Cloud Run デプロイ単位)
│   ├── app_customer_support.py      # Flask + WebSocket エンドポイント
│   ├── live_session.py              # 🚨 LiveAPI コア（変更最小限）
│   ├── support_core.py              # セッション管理 + AI 会話ロジック
│   ├── api_integrations.py          # 外部 API 連携（変更なし）
│   ├── long_term_memory.py          # Supabase 長期記憶（変更なし）
│   ├── prompts/                     # システムプロンプト（変更なし）
│   ├── requirements.txt
│   └── Dockerfile
│
└── src/                             # フロントエンド (Vercel デプロイ単位)
    ├── scripts/chat/
    │   ├── core-controller.ts       # 共通 UI ロジック + LiveAPI ハンドラ
    │   ├── chat-controller.ts       # グルメモード固有
    │   ├── concierge-controller.ts  # コンシェルジュモード固有
    │   ├── live-websocket.ts        # LiveAPI WebSocket クライアント
    │   └── audio-manager.ts         # マイク音声キャプチャ (AudioWorklet)
    ├── components/
    │   ├── GourmetChat.astro        # グルメモード UI
    │   ├── Concierge.astro          # コンシェルジュモード UI
    │   └── ShopCardList.astro       # ショップカード表示
    └── pages/
        ├── index.astro              # / (グルメモード)
        └── concierge.astro          # /concierge
```

---

## 2. バックエンド仕様

### 2-1. REST API エンドポイント一覧

| メソッド | パス | 用途 | LiveAPI移行後 |
|---------|------|------|--------------|
| POST | `/api/session/start` | セッション開始 | **維持** (LiveAPI 前に必要) |
| POST | `/api/chat` | テキストチャット | **フォールバック用に維持** |
| POST | `/api/tts/synthesize` | Cloud TTS | **維持** (ショップカード紹介用) |
| POST | `/api/stt/transcribe` | 一発認識 | **維持** (フォールバック用) |
| POST | `/api/finalize` | セッション終了 | **維持** |
| POST | `/api/cancel` | 処理中止 | **維持** |
| GET | `/api/session/<id>` | セッション取得 | **維持** |
| GET | `/health` | ヘルスチェック | **維持** |
| WS | `/ws/live/<session_id>` | **LiveAPI 本線** | ✅ メイン通信路 |

### 2-2. セッション開始フロー（/api/session/start）

🚨 **処理順序を厳守（番号順）**

```python
# app_customer_support.py: start_session()
#
# 1. リクエストパース
data = request.json or {}
user_info = data.get('user_info', {})
language = data.get('language', 'ja')
mode = data.get('mode', 'chat')        # 'chat' | 'concierge'

# 2. セッション作成（RAMベース）
session = SupportSession()
session.initialize(user_info, language=language, mode=mode)

# 3. アシスタント作成
assistant = SupportAssistant(session, SYSTEM_PROMPTS)

# 4. 初回メッセージ生成（長期記憶対応）
initial_message = assistant.get_initial_message()

# 5. 履歴に追加
session.add_message('model', initial_message, 'chat')

# 6. 初期TTS生成（Cloud TTS、MP3）
tts_response = tts_client.synthesize_speech(...)

# 7. レスポンス返却
return jsonify({
    'session_id': session.session_id,
    'initial_message': initial_message,
    'initial_tts': base64_encoded_mp3   # フロントで即再生
})
```

### 2-3. LiveAPI WebSocket エンドポイント（/ws/live/<session_id>）

🚨 **処理順序を厳守**

```python
# app_customer_support.py: live_websocket(ws, session_id)
#
# 1. セッション検証
session = SupportSession(session_id)
session_data = session.get_data()
if not session_data:
    ws.send(json.dumps({'type': 'error', 'data': 'セッションが見つかりません'}))
    return

# 2. システムプロンプト取得
language = session_data.get('language', 'ja')
mode = session_data.get('mode', 'chat')
mode_prompts = SYSTEM_PROMPTS.get(mode, SYSTEM_PROMPTS.get('chat', {}))
system_prompt = mode_prompts.get(language, mode_prompts.get('ja', ''))

# 3. LiveAPIセッション作成・開始
live_session = live_session_manager.create(
    session_id, system_prompt, ws, language, mode
)

# 4. ブラウザからのメッセージをリレー
try:
    while True:
        data = ws.receive(timeout=300)  # 🚨 タイムアウト: 300秒
        if data is None:
            break
        msg = json.loads(data)
        msg_type = msg.get('type')

        if msg_type == 'audio_chunk':
            live_session.send_audio(msg.get('data', ''))
        elif msg_type == 'text_input':
            text = msg.get('data', '')
            if text:
                session.add_message('user', text, 'chat')
                live_session.send_text(text)
        elif msg_type == 'cancel':
            break
finally:
    live_session_manager.remove(session_id)
```

### 2-4. live_session.py 主要パラメータ

🚨 **以下の値は変更禁止。変更するとLiveAPIが動作しなくなる。**

| パラメータ | 値 | 根拠 |
|-----------|-----|------|
| `LIVE_API_MODEL` | `"gemini-2.5-flash-native-audio-preview-12-2025"` | 本番稼働実績 |
| `REST_API_MODEL` | `"gemini-2.5-flash"` | ショップ説明生成用 |
| `SEND_SAMPLE_RATE` | `16000` | 16kHz mono PCM |
| `RECEIVE_SAMPLE_RATE` | `24000` | 24kHz mono PCM |
| `MAX_AI_CHARS_BEFORE_RECONNECT` | `800` | stt_stream.py 準拠 |
| `LONG_SPEECH_THRESHOLD` | `500` | stt_stream.py 準拠 |
| `audio_queue maxsize` | `5` | バックプレッシャー制御 |
| `ws.receive timeout` | `300` | Cloud Run タイムアウト対応 |
| 会話履歴保持 | `20ターン` | stt_stream.py 準拠 |

### 2-5. LiveAPI 設定（build_live_config）

🚨 **この設定は live_session.py の本番稼働コードそのもの。変更禁止。**

```python
def build_live_config(system_prompt):
    return {
        "response_modalities": ["AUDIO"],
        "system_instruction": system_prompt,
        "input_audio_transcription": {},
        "output_audio_transcription": {},
        "speech_config": {
            "language_code": "ja-JP",
            "voice_config": {
                "prebuilt_voice_config": {
                    "voice_name": "Aoede"
                }
            },
        },
        "realtime_input_config": {
            "automatic_activity_detection": {
                "disabled": False,
                "start_of_speech_sensitivity": "START_SENSITIVITY_HIGH",
                "end_of_speech_sensitivity": "END_SENSITIVITY_HIGH",
                "prefix_padding_ms": 500,
                "silence_duration_ms": 500,
            }
        },
        "context_window_compression": {
            "sliding_window": {
                "target_tokens": 32000,
            }
        },
        "tools": [SEARCH_TOOL],
    }
```

### 2-6. ツールコール処理（search_restaurants）

🚨 **処理順序（1〜8）を厳守。順序変更は禁止。**

```
1. tool_call 受信 (response.tool_call.function_calls)
2. function_name が "search_restaurants" か判定
3. query, area パラメータ取得
4. ブラウザに { type: 'searching' } 送信（ウエイティングアニメ発火）
5. Google Places 検索 + enrichment + REST API 説明生成（並行実行）
6. Cloud TTS で紹介テキスト音声合成
7. ブラウザに { type: 'shops', data: { response, shops, ttsAudio } } 送信
8. Gemini に send_tool_response で結果を返す
```

🚨 **ステップ 7 と 8 の順序が重要**:
- ブラウザへの shops 送信 → Gemini への tool_response 送信
- 逆にすると、Gemini が応答を生成してしまい、ショップ紹介と二重になる

### 2-7. ショップカード紹介のREST維持パターン

ショップカード紹介は **長文** のため、LiveAPIの音声出力ではなく REST API + Cloud TTS を使用:

```
[LiveAPIルート]
  ユーザー: 「恵比寿で焼き鳥」
  AI (LiveAPI音声): 「恵比寿で焼き鳥ですね、お探しします！」
  → search_restaurants ツール呼び出し
  → Google Places 検索
  → REST API (gemini-2.5-flash) でショップ説明生成
  → Cloud TTS で説明音声合成（MP3 base64）
  → { type: 'shops' } でフロントに送信（shops + ttsAudio）
  → フロントは Cloud TTS 音声を再生
  → LiveAPI の次の音声ターンは suppressNextLiveAudio で抑制
```

---

## 3. フロントエンド仕様

### 3-1. WebSocket メッセージプロトコル

#### クライアント → サーバー

| type | data | 説明 |
|------|------|------|
| `audio_chunk` | base64 PCM (16kHz 16bit mono) | マイク音声チャンク |
| `text_input` | string | テキスト入力 |
| `cancel` | null | セッションキャンセル |

#### サーバー → クライアント

| type | data | 説明 |
|------|------|------|
| `live_ready` | なし | Gemini 接続完了 |
| `text` | string | AI 発話テキスト (output_transcription) |
| `input_transcription` | string | ユーザー発話テキスト |
| `audio` | base64 PCM (24kHz 16bit mono) | AI 音声データ |
| `turn_complete` | なし | AI ターン完了 |
| `interrupted` | なし | Gemini VAD 割り込み検知 |
| `shops` | `{ response, shops, ttsAudio }` | ショップ検索結果 |
| `searching` | なし | 検索開始通知 |
| `error` | string | エラーメッセージ |

### 3-2. core-controller.ts メッセージ処理フロー

🚨 **各ハンドラの処理順序を厳守**

#### 通常会話ターン

```
1. handleLiveAudio(base64)     → pendingAudioChunks に蓄積
2. handleLiveText(text)        → pendingResponseText に蓄積
3. handleLiveTurnComplete()    → テキスト表示 + PCM音声再生
   3-1. hideWaitOverlay()
   3-2. finalizeUserTranscript()
   3-3. addMessage('assistant', pendingResponseText)
   3-4. playLiveAudioChunks(pendingAudioChunks)  ← 24kHz PCM → WAV変換 → 再生
   3-5. resetInputState()
```

#### ショップ検索ターン

```
1. handleLiveSearching()       → showWaitOverlay() + 事前生成相槌TTS再生
2. handleLiveShops(data)       → ショップカード表示 + Cloud TTS 再生
   2-1. hideWaitOverlay()
   2-2. finalizeUserTranscript()
   2-3. addMessage('assistant', response)
   2-4. displayShops イベント発火
   2-5. Cloud TTS 音声 (ttsAudio) を ttsPlayer で再生
   2-6. suppressNextLiveAudio = true  ← 🚨 重要: 次のLiveAPI音声を抑制
   2-7. resetInputState()
3. handleLiveTurnComplete()    → suppressNextLiveAudio なので全スキップ
```

### 3-3. PCM 音声再生仕様

🚨 **以下の値は live_session.py の RECEIVE_SAMPLE_RATE と一致させること**

```typescript
// live-websocket.ts
export const OUTPUT_SAMPLE_RATE = 24000;  // 🚨 24kHz固定（Gemini出力）

// core-controller.ts: playLiveAudioChunks()
// 1. 全チャンクの base64 をデコード → Uint8Array に結合
// 2. WAV ヘッダー生成: sampleRate=24000, bitsPerSample=16, channels=1
// 3. Blob('audio/wav') → URL.createObjectURL → ttsPlayer.src
// 4. ttsPlayer.play()
```

### 3-4. AudioWorklet 仕様（audio-manager.ts）

🚨 **以下の値は固定。live_session.py の SEND_SAMPLE_RATE と一致させること**

```typescript
const TARGET_SAMPLE_RATE = 16000;   // 🚨 16kHz固定（Gemini入力）
const MAX_RECORDING_TIME = 60000;   // 60秒安全弁
const IOS_BUFFER_SIZE = 8192;       // iOS: 大きめバッファ
const DEFAULT_BUFFER_SIZE = 3200;   // PC/Android: 200ms分
```

処理フロー:
1. `getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })`
2. AudioContext (48kHz native) → AudioWorklet で 16kHz にダウンサンプル
3. Float32 → Int16 PCM 変換
4. base64 エンコード → `onAudioChunk` コールバック
5. LiveWebSocket.sendAudio() で送信

### 3-5. 自動再接続仕様（live-websocket.ts）

```typescript
MAX_RECONNECT_ATTEMPTS = 5;
BASE_RECONNECT_DELAY = 2000;  // 2秒

// 指数バックオフ: 2s, 4s, 8s, 16s, 32s
delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts);

// 全リトライ失敗時 → onClose コールバック → resetAppContent()
```

---

## 4. 移植元との対応表

### 4-1. バックエンド: stt_stream.py → live_session.py

| stt_stream.py | live_session.py | 差異 |
|--------------|-----------------|------|
| `GeminiLiveApp` | `LiveSession` | クラス名のみ |
| `pyaudio` 入出力 | ブラウザ WebSocket リレー | I/O層の差異 |
| `run()` + `_session_loop()` | `_session_loop()` | 統合済み |
| `send_audio()` (listen_audio) | `_send_audio()` | 名前変更 |
| `receive_audio()` | `_receive()` | 名前変更 |
| `_handle_tool_call()` | `_handle_tool_call()` | ツール内容が異なる |
| 800文字再接続閾値 | 800文字再接続閾値 | **同値** |
| 500文字長文閾値 | 500文字長文閾値 | **同値** |
| 20ターン履歴保持 | 20ターン履歴保持 | **同値** |

### 4-2. フロントエンド: gourmet-sp (安定版) → gourmet-sp2 (現行)

| gourmet-sp (安定版) | gourmet-sp2 (現行) | 差異 |
|---------------------|-------------------|------|
| Socket.IO STT | AudioWorklet → LiveAPI WS | 根本変更 |
| REST `/api/chat` | LiveAPI WS `text_input` | 本線変更 |
| Cloud TTS 全応答 | LiveAPI PCM音声 (24kHz) | 通常会話のみ |
| REST `/api/tts/synthesize` | REST維持（ショップカード紹介） | 部分維持 |
| 事前生成相槌TTS | 事前生成相槌TTS | **変更なし** |

---

## 5. デプロイ仕様

### 5-1. バックエンド (Cloud Run)

```bash
# デプロイコマンド（Windows PowerShell から実行）
cd support-base
gcloud builds submit --tag gcr.io/ai-meet-486502/support-base
gcloud run deploy support-base `
  --image gcr.io/ai-meet-486502/support-base `
  --region us-central1 `
  --allow-unauthenticated `
  --port 8080 `
  --timeout 300 `
  --min-instances 1
```

🚨 **`--timeout 300`** は必須。LiveAPI WebSocket は長時間接続。
🚨 **`--min-instances 1`** は推奨。コールドスタート回避。

### 5-2. Dockerfile

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app_customer_support.py .
COPY support_core.py .
COPY api_integrations.py .
COPY long_term_memory.py .
COPY live_session.py .
COPY templates/ templates/
COPY prompts/ prompts/
EXPOSE 8080
CMD exec gunicorn --bind :$PORT --workers 1 --threads 8 --timeout 0 app_customer_support:app
```

🚨 **`--workers 1`**: LiveAPI は WebSocket + asyncio スレッドを使用。
複数ワーカーは WebSocket セッションの不整合を起こす。
🚨 **`--timeout 0`**: Gunicorn のリクエストタイムアウト無効化（WebSocket 対応）。

### 5-3. フロントエンド (Vercel)

```bash
# Astro ビルド
npm run build
# Vercel へのデプロイは git push で自動
```

### 5-4. 環境変数（Cloud Run）

| 変数名 | 値 | 必須 |
|--------|-----|------|
| `GEMINI_API_KEY` | Gemini API キー | ✅ |
| `GOOGLE_PLACES_API_KEY` | Places API キー | ✅ |
| `SUPABASE_URL` | Supabase URL | ✅ (concierge) |
| `SUPABASE_SERVICE_KEY` | Supabase キー | ✅ (concierge) |
| `PROMPTS_BUCKET_NAME` | GCS バケット名 | 任意 |
| `AUDIO2EXP_SERVICE_URL` | A2E サービス URL | 任意 (フェーズ2) |
| `PORT` | `8080` | Cloud Run 自動設定 |

---

## 6. 検証条件（assert）

### 6-1. バックエンド検証

```python
# /health エンドポイントで以下が返ること
assert response['status'] == 'healthy'
assert response['services']['gemini'] == 'ok'
assert response['services']['tts'] == 'ok'
assert response['services']['live_api'] == 'ok'
assert response['services']['flask_sock'] == 'ok'
assert response['services']['places_api'] == 'ok'
assert 'live' in response['build_version']

# /api/session/start で以下が返ること
assert 'session_id' in response
assert 'initial_message' in response
assert len(response['initial_message']) > 0

# WebSocket /ws/live/<session_id> 接続で以下が受信できること
assert first_message['type'] == 'live_ready'

# テキスト入力送信後、以下のメッセージが受信できること
assert any(msg['type'] == 'text' for msg in received_messages)
assert any(msg['type'] == 'audio' for msg in received_messages)
assert any(msg['type'] == 'turn_complete' for msg in received_messages)
```

### 6-2. フロントエンド検証

```typescript
// LiveWebSocket 接続確立
assert(liveWs.isConnected() === true);

// マイク録音開始後、audio_chunk が送信されること
assert(sentMessages.some(m => m.type === 'audio_chunk'));

// ショップ検索結果受信時
assert(shopData.shops.length > 0);
assert(shopData.ttsAudio !== '');  // Cloud TTS 音声が含まれること

// PCM音声再生
assert(OUTPUT_SAMPLE_RATE === 24000);  // live_session.py と一致
assert(wavHeader.sampleRate === 24000);
assert(wavHeader.bitsPerSample === 16);
assert(wavHeader.channels === 1);
```

### 6-3. E2E 検証シナリオ

```
シナリオ1: グルメモード基本会話
  1. / にアクセス
  2. 初期メッセージ + TTS 再生を確認
  3. マイクボタンをタップ → 録音開始
  4. 「恵比寿で焼き鳥」と発話
  5. input_transcription でテキスト表示を確認
  6. AI 音声応答を確認
  7. 「お探しします」→ ウエイティングアニメ表示
  8. ショップカード 3〜5枚が表示
  9. Cloud TTS で紹介セリフ再生
  10. 次のマイク入力が可能なことを確認

シナリオ2: コンシェルジュモード基本会話
  1. /concierge にアクセス
  2. 初期メッセージ（長期記憶対応挨拶） + TTS 再生を確認
  3. テキスト入力「渋谷でイタリアン」を送信
  4. LiveAPI 経由で応答を確認
  5. ショップカード表示 + Cloud TTS 紹介を確認

シナリオ3: バックグラウンド復帰
  1. アプリをバックグラウンドに
  2. 30秒後にフォアグラウンドに復帰
  3. LiveAPI WebSocket 再接続を確認
  4. 会話が継続できることを確認

シナリオ4: バックグラウンド長時間
  1. アプリをバックグラウンドに
  2. 2分以上経過後にフォアグラウンドに復帰
  3. セッションリセット → 新規セッション開始を確認
```

---

## 7. 既知の課題と対策

### 7-1. isUserInteracted 問題

現状: ブラウザの自動再生制限により、ユーザーが一度もタップしていない状態では音声が再生できない。

対策: `enableAudioPlayback()` をマイクボタン押下時に呼び出し済み。初期TTS は `isUserInteracted` が false の場合スキップ。

### 7-2. iOS Safari の AudioContext 制限

対策: `audio-manager.ts` で iOS の場合 AudioContext をセッション跨ぎで再利用。

### 7-3. Cloud Run の WebSocket タイムアウト

対策:
- `--timeout 300` でリクエストタイムアウトを5分に設定
- `ws.receive(timeout=300)` でサーバー側タイムアウトを合わせる
- フロントエンドで自動再接続（指数バックオフ）

### 7-4. Gemini LiveAPI のコンテキスト切れ

対策:
- `context_window_compression: { sliding_window: { target_tokens: 32000 } }`
- 累積800文字で予防的再接続
- 再接続時に会話履歴コンテキストをシステムプロンプトに注入
