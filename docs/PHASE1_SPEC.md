# フェーズ1 設計仕様書: REST API → LiveAPI 変換

**日付**: 2026-03-07
**バージョン**: v3.0
**ベース**: 旧安定版 gourmet-support (Flask) + gourmet-sp (Astro)
**対象リポジトリ**: gourmet-sp2（バックエンド support-base/ + フロントエンド src/）

---

## 原則7: AIの知識が不足している技術

```
🚨 Gemini Live API (google.genai の Live API)
- 2025年後半リリース。AIの訓練データに含まれていない可能性が高い
- 正確なインターフェースは google-genai パッケージのバージョンに依存
- 不明な部分は TODO コメントで明示し、手動検証を要求する

🚨 AIがやりがちな間違い:
- genai.Client() と genai.GenerativeModel() を混同する
- Live API の connect() メソッドのシグネチャを間違える
- WebSocket メッセージフォーマットを推測で書く
- 存在しないメソッドやプロパティを自信を持って使う
```

---

## 1. 変換の全体像

### 旧アーキテクチャ（REST API）

```
フロントエンド (Astro + TypeScript)
  │
  ├── REST POST /api/chat → Flask バックエンド → Gemini REST API → レスポンス
  ├── REST POST /api/tts/synthesize → Google Cloud TTS → 音声
  ├── Socket.IO /api/stt → Google Cloud STT → テキスト（ストリーミング）
  └── HTMLAudioElement で TTS 再生
```

### 新アーキテクチャ（LiveAPI）

```
🚨 この図の通りに実装する。追加・省略しない。

フロントエンド (Astro + TypeScript)
  │
  ├── WebSocket /api/v2/live/{session_id} → FastAPI → Gemini Live API（双方向）
  │     ├── テキスト送信 → Gemini応答（テキストストリーミング）
  │     ├── 音声送信 → Gemini応答（テキスト or 音声）
  │     └── tool_call → レストラン検索 → ショップデータ
  │
  └── REST POST /api/v2/rest/tts/synthesize → Google Cloud TTS（ショップ紹介セリフのみ）
```

### やらないこと（原則5）

```
🚨 以下は実装しない:
1. Socket.IO による STT ストリーミング — LiveAPI が音声入力を直接処理
2. REST POST /api/chat — LiveAPI WebSocket に統合
3. フロントエンド側の独自 VAD — Gemini Live API の内蔵 VAD を使用
4. preGeneratedAcks（事前生成ACK音声）— LiveAPI がリアルタイム応答するため不要
5. generateFallbackResponse — LiveAPI がリアルタイム応答するため不要
6. selectSmartAcknowledgment — LiveAPI がリアルタイム応答するため不要
7. additionalResponse — LiveAPI がリアルタイム応答するため不要
8. フロントエンドからの直接 Gemini API 呼び出し — バックエンド経由のみ
```

---

## 2. バックエンド仕様 (support-base/)

### 2.1 ディレクトリ構成

```
🚨 この構成の通り

support-base/
├── Dockerfile
├── cloudbuild.yaml
├── requirements.txt
├── prompts/
│   ├── system_gourmet.txt
│   └── system_concierge.txt
└── support_base/
    ├── __init__.py
    ├── config.py
    ├── server.py
    ├── live/
    │   ├── __init__.py
    │   └── relay.py
    └── rest/
        ├── __init__.py
        └── router.py
```

### 2.2 config.py

```python
🚨 改変禁止

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
```

### 2.3 server.py エンドポイント

```
🚨 エンドポイントのパスとシグネチャを変更しない

POST /api/v2/session/start
  リクエスト: { user_info: {}, language: "ja", mode: "gourmet" }
  レスポンス: { session_id: "sess_xxxxxxxxxxxx", initial_message: "..." }

POST /api/v2/session/end
  リクエスト: { session_id: "sess_xxx" }
  レスポンス: { session_id: "sess_xxx", ended: true }

WS /api/v2/live/{session_id}
  → LiveRelay クラスが処理（後述）

POST /api/v2/rest/tts/synthesize
  リクエスト: { text: "...", language_code: "ja-JP", voice_name: "ja-JP-Chirp3-HD-Leda", session_id: "" }
  レスポンス: { success: true, audio: "<base64 MP3>" }

GET /health
  レスポンス: { status: "ok" }
```

#### server.py の重要ポイント

```
🚨 session/start は ws_url を返さない
🚨 フロントエンドが session_id を使って WebSocket URL を自力で構築する
🚨 WebSocket URL = /api/v2/live/{session_id}
```

### 2.4 live/relay.py（Gemini Live API 中継）

#### 処理フロー（番号付き厳守 — 原則3）

```
🚨 この順序を変更しない

1. Gemini クライアント初期化: genai.Client(api_key=GEMINI_API_KEY)
2. システムプロンプト構築（mode に応じて切り替え）
3. Function Calling ツール定義（search_restaurants）
4. LiveConnectConfig 構築:
   - response_modalities=["TEXT"]  ← 🚨 テキスト応答のみ（音声はREST TTSで生成）
   - system_instruction=...
   - tools=...
5. Gemini Live API 接続: client.aio.live.connect(model=..., config=...)
6. フロントエンドに { type: "connected" } 送信
7. 並行ループ開始:
   A. フロントエンド→Gemini 転送ループ
   B. Gemini→フロントエンド 転送ループ
```

#### フロントエンド→Gemini メッセージ処理

```python
🚨 改変禁止

msg_type == "text" の場合:
    text = data.get("text", "")  # 🚨 フィールド名は "text"（"data" ではない）
    await gemini_session.send(input=text, end_of_turn=True)

msg_type == "audio" の場合:
    # フェーズ1: pass（音声入力は将来対応）

msg_type == "close" の場合:
    self._running = False
```

#### Gemini→フロントエンド メッセージ処理

```python
🚨 改変禁止

応答ストリーム:
    sc = response.server_content
    if not sc:
        # tool_call チェック
        if hasattr(response, "tool_call") and response.tool_call:
            await self._handle_tool_call(response.tool_call)
        continue

    # テキスト応答チャンク
    if sc.model_turn and sc.model_turn.parts:
        for part in sc.model_turn.parts:
            if part.text:
                await websocket.send_json({"type": "text", "text": part.text})

    # ターン完了
    if sc.turn_complete:
        await websocket.send_json({"type": "turn_complete"})
```

#### tool_call 処理フロー

```
🚨 この順序を変更しない

1. function_call の名前とパラメータを取得
2. search_restaurants の場合: Google Places API でレストラン検索
3. ショップデータをフロントエンドに先行送信:
   { type: "shop_data", shops: [...] }
4. 検索結果を Gemini に tool_response として返す
5. Gemini がショップ紹介テキストを生成 → text チャンクで送信
6. Gemini が turn_complete を送信
```

### 2.5 rest/router.py

```
🚨 改変禁止
ショップ紹介時の長文TTS生成のみに使用
通常会話には使用しない（LiveAPI WebSocket を使用）
```

---

## 3. フロントエンド仕様 (src/)

### 3.1 変更対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `core-controller.ts` | 🚨 大幅書き換え: Socket.IO → WebSocket, REST /api/chat → WebSocket, 新メッセージハンドラ |
| `chat-controller.ts` | 最小限の修正（currentMode 設定のみ） |
| `concierge-controller.ts` | handleWsMessage オーバーライド修正 |
| `audio-manager.ts` | 変更なし（既に audio-streaming-fix-plan.md の修正が反映済み） |
| `GourmetChat.astro` | Socket.IO CDN の `<script>` タグ削除 |
| `Concierge.astro` | Socket.IO CDN の `<script>` タグ削除 |

### 3.2 WebSocket メッセージフォーマット

```typescript
🚨 改変禁止 — フロントエンド ↔ バックエンド間のメッセージ

// ============================================
// フロントエンド → バックエンド
// ============================================

// テキスト入力
{ type: "text", text: "渋谷でイタリアン" }
//                ^^^^
// 🚨 フィールド名は "text"。"data" ではない。
// 🚨 relay.py が data.get("text", "") で読むため

// 切断
{ type: "close" }

// ============================================
// バックエンド → フロントエンド
// ============================================

// 接続確立
{ type: "connected" }

// テキスト応答（ストリーミング — チャンクごとに送信される）
{ type: "text", text: "渋谷でおすすめの" }
{ type: "text", text: "イタリアンですね。" }

// ターン完了（Geminiの応答が完了）
{ type: "turn_complete" }

// ショップ検索結果（tool_call 実行後、テキスト応答の前に送信）
{ type: "shop_data", shops: [{ name: "...", category: "...", ... }] }

// エラー
{ type: "error", message: "..." }
```

### 3.3 core-controller.ts 変更仕様（旧版との対応表 — 原則6）

| 旧版 (gourmet-sp) | 新版 (gourmet-sp2) | 備考 |
|---|---|---|
| `socket: any` (Socket.IO) | `liveWs: WebSocket \| null` | ネイティブ WebSocket に変更 |
| `initSocket()` — Socket.IO 初期化 | `connectLiveAPI()` — WebSocket 接続 | session_id 取得後に呼ぶ |
| `socket.emit('audio_chunk', ...)` | `liveWs.send(JSON.stringify({type: "audio", ...}))` | フェーズ1ではテキストのみ |
| `socket.on('transcript', ...)` | `handleLiveMessage() case "text"` | テキストストリーミング |
| `fetch('/api/chat', ...)` | `liveWs.send({type: "text", text: ...})` | REST → WebSocket |
| `data.response`（REST応答） | `responseBuffer`（ストリーミング蓄積） | チャンク → バッファ → turn_complete で確定 |
| `preGeneratedAcks` | 削除 | LiveAPI がリアルタイム応答 |
| `selectSmartAcknowledgment()` | 削除 | LiveAPI がリアルタイム応答 |
| `generateFallbackResponse()` | 削除 | LiveAPI がリアルタイム応答 |
| `ttsPlayer.src = data:audio/mp3;base64,...` | `audioManager.playMp3Audio(base64)` | Web Audio API に統一 |

### 3.4 core-controller.ts 処理フロー

#### フロー1: セッション開始

```
🚨 この順序を変更しない

1. フロントエンド: POST /api/v2/session/start { language: "ja", mode: "gourmet" }
2. バックエンド: session_id を生成（UUID）、レスポンス返却
3. フロントエンド: this.sessionId = data.session_id を保存
4. フロントエンド: WebSocket URL を構築（🚨 data.ws_url は存在しない）
   const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
   const backendHost = new URL(this.apiBase || location.origin).host;
   const wsUrl = `${wsProtocol}//${backendHost}/api/v2/live/${this.sessionId}`;
5. フロントエンド: new WebSocket(wsUrl) で接続
6. バックエンド: Gemini Live API セッション開始
7. バックエンド: { type: "connected" } 送信
8. フロントエンド: 初回挨拶を表示
9. フロントエンド: REST TTS で挨拶音声を再生
10. フロントエンド: UI を有効化（入力欄、ボタン等）
```

#### フロー2: テキスト入力 → AI応答

```
🚨 この順序を変更しない

1. ユーザーがテキスト入力して送信ボタンを押す
2. フロントエンド: チャットエリアにユーザーメッセージを表示
3. フロントエンド: this.els.userInput.value = '' でクリア
4. フロントエンド: isProcessing = true
5. フロントエンド: WebSocket 送信 { type: "text", text: message }
   🚨 ここで ACK は表示しない。Gemini が直接応答する。
6. バックエンド: Gemini にテキスト転送
7. Gemini: テキスト応答をストリーミング
8. バックエンド: { type: "text", text: "..." } をチャンクごとに送信
9. フロントエンド: responseBuffer にテキストを蓄積
10. フロントエンド: ストリーミング表示（updateStreamingMessage）
11. Gemini: turn_complete
12. バックエンド: { type: "turn_complete" } 送信
13. フロントエンド: ストリーミング確定（finalizeStreamingMessage）
14. フロントエンド: REST TTS でAI応答を音声合成・再生
15. フロントエンド: isProcessing = false、入力欄を再有効化
```

#### フロー3: ショップ検索

```
🚨 この順序を変更しない

1. Gemini が tool_call を返す
2. バックエンド: Google Places API でレストラン検索
3. バックエンド: { type: "shop_data", shops: [...] } を WebSocket で送信
4. フロントエンド: ショップカードを表示
5. バックエンド: tool_response を Gemini に返す
6. Gemini: ショップ紹介テキストを生成（ストリーミング）
7. バックエンド: { type: "text", text: "..." } をチャンクごとに送信
8. フロントエンド: responseBuffer にテキストを蓄積
9. Gemini: turn_complete
10. バックエンド: { type: "turn_complete" } 送信
11. フロントエンド: ストリーミング確定
12. フロントエンド: REST TTS でショップ紹介セリフを音声合成・再生
    🚨 ショップ紹介は長文なので REST TTS 必須
```

### 3.5 core-controller.ts 新プロパティ

```typescript
🚨 以下のプロパティを追加する

// LiveAPI WebSocket（Socket.IO を置き換え）
protected liveWs: WebSocket | null = null;

// ストリーミングテキストバッファ（Gemini応答チャンクを蓄積）
protected responseBuffer: string = "";
```

### 3.6 core-controller.ts 削除するプロパティ・メソッド

```typescript
🚨 以下を削除する

// プロパティ
protected preGeneratedAcks: Map<string, string>  // ACK事前生成は不要
protected ws: WebSocket | null  // liveWs に置き換え
protected wsUrl: string  // 不要

// メソッド
protected initWebSocket()  // connectLiveAPI() に置き換え
protected handleWsMessage()  // handleLiveMessage() に置き換え
protected wsSend()  // sendToLive() に置き換え
protected selectSmartAcknowledgment()  // LiveAPIが直接応答するため不要
protected generateFallbackResponse()  // LiveAPIが直接応答するため不要
```

### 3.7 core-controller.ts 新メソッド仕様

#### connectLiveAPI()

```typescript
🚨 改変禁止 — WebSocket 接続

protected connectLiveAPI() {
  const backendUrl = this.apiBase || window.location.origin;
  const wsProtocol = backendUrl.startsWith('https') ? 'wss' : 'ws';
  const wsHost = backendUrl.replace(/^https?:\/\//, '');
  const url = `${wsProtocol}://${wsHost}/api/v2/live/${this.sessionId}`;

  this.liveWs = new WebSocket(url);

  this.liveWs.onopen = () => {
    console.log('[LiveAPI] WebSocket connected');
  };

  this.liveWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      this.handleLiveMessage(msg);
    } catch (e) {
      console.error('[LiveAPI] Parse error:', e);
    }
  };

  this.liveWs.onclose = () => {
    console.log('[LiveAPI] WebSocket disconnected');
    this.liveWs = null;
  };

  this.liveWs.onerror = (err) => {
    console.error('[LiveAPI] WebSocket error:', err);
  };
}
```

#### sendToLive()

```typescript
🚨 改変禁止

protected sendToLive(msg: object) {
  if (this.liveWs && this.liveWs.readyState === WebSocket.OPEN) {
    this.liveWs.send(JSON.stringify(msg));
  }
}
```

#### handleLiveMessage()

```typescript
🚨 改変禁止 — メッセージタイプと処理を正確に実装

protected handleLiveMessage(msg: any) {
  switch (msg.type) {
    case 'connected':
      console.log('[LiveAPI] Gemini session ready');
      break;

    case 'text':
      // 🚨 Geminiからのテキストストリーミング — チャンクごとに呼ばれる
      this.hideWaitOverlay();
      this.responseBuffer += msg.text;
      this.updateStreamingMessage('assistant', this.responseBuffer);
      break;

    case 'turn_complete':
      // 🚨 Geminiの応答完了
      if (this.responseBuffer) {
        this.finalizeStreamingMessage('assistant', this.responseBuffer);
        // REST TTS で音声合成・再生
        if (this.isTTSEnabled) {
          this.speakTextGCP(this.responseBuffer);
        }
        this.responseBuffer = "";
      }
      this.isAISpeaking = false;
      this.resetInputState();
      break;

    case 'shop_data':
      // 🚨 ショップ検索結果（tool_call実行後）
      this.hideWaitOverlay();
      if (msg.shops && msg.shops.length > 0) {
        this.currentShops = msg.shops;
        this.els.reservationBtn.classList.add('visible');
        document.dispatchEvent(new CustomEvent('displayShops', {
          detail: { shops: msg.shops, language: this.currentLanguage }
        }));
        const section = document.getElementById('shopListSection');
        if (section) section.classList.add('has-shops');
        if (window.innerWidth < 1024) {
          setTimeout(() => {
            const shopSection = document.getElementById('shopListSection');
            if (shopSection) shopSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 300);
        }
      }
      // 🚨 ショップ紹介テキストはこの後の text チャンクで届く
      // 🚨 ここでは resetInputState() しない（テキスト応答を待つ）
      break;

    case 'error':
      this.addMessage('system', msg.message || 'エラーが発生しました');
      this.hideWaitOverlay();
      this.resetInputState();
      break;
  }
}
```

#### initializeSession() 変更箇所

```typescript
🚨 以下の変更のみ行う

// 旧: Socket.IO 関連を削除
// 旧: data.ws_url による WebSocket 接続を削除
// 旧: preGeneratedAcks の事前生成を削除

// 新: session_id 取得後に connectLiveAPI() を呼ぶ
async initializeSession() {
  // ... session/end（旧セッション終了）...

  // 🚨 既存 LiveAPI WebSocket を閉じる
  if (this.liveWs) {
    try { this.liveWs.close(); } catch (_e) {}
    this.liveWs = null;
  }

  // session/start リクエスト
  const res = await fetch(`${this.apiBase}/api/v2/session/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: this.currentMode,
      language: this.currentLanguage,
    })
  });
  const data = await res.json();
  this.sessionId = data.session_id;

  // 🚨 LiveAPI WebSocket 接続（session_id から URL を構築）
  this.connectLiveAPI();

  // 挨拶表示
  this.addMessage('assistant', data.initial_message || this.t('initialGreeting'), null, true);

  // UI 有効化
  this.els.userInput.disabled = false;
  this.els.sendBtn.disabled = false;
  this.els.micBtn.disabled = false;
  this.els.speakerBtn.disabled = false;

  // 挨拶音声（REST TTS）
  if (this.isTTSEnabled) {
    this.speakTextGCP(data.initial_message || this.t('initialGreeting'));
  }
}
```

#### sendMessage() 変更箇所

```typescript
🚨 大幅簡略化 — ACK/fallback/additionalResponse を全て削除

async sendMessage() {
  this.enableAudioPlayback();
  const message = this.els.userInput.value.trim();
  if (!message || this.isProcessing) return;

  // 1. ユーザーメッセージ表示
  this.addMessage('user', message);
  this.els.userInput.value = '';

  // 2. 入力無効化
  this.isProcessing = true;
  this.els.sendBtn.disabled = true;
  this.els.micBtn.disabled = true;
  this.els.userInput.disabled = true;

  // 3. 待機アニメーション
  if (this.waitOverlayTimer) clearTimeout(this.waitOverlayTimer);
  this.waitOverlayTimer = window.setTimeout(() => { this.showWaitOverlay(); }, 4000);

  // 4. 🚨 WebSocket でテキスト送信（REST /api/chat は使わない）
  this.sendToLive({ type: 'text', text: message });
  //                               ^^^^
  // 🚨 フィールド名は "text"。"data" ではない。

  this.els.userInput.blur();
  // レスポンスは handleLiveMessage() で処理
}
```

### 3.8 concierge-controller.ts 変更仕様

```
🚨 以下の変更のみ行う

1. initializeSession() オーバーライド:
   - 親クラスと同様に connectLiveAPI() を呼ぶ
   - コンシェルジュ用挨拶テキストを使用
   - preGeneratedAcks 削除

2. handleLiveMessage() オーバーライド:
   - case 'text': 親クラスと同じ（追加処理なし）
   - case 'turn_complete': 親クラスと同じ + アバターアニメーション停止
   - case 'shop_data': 親クラス処理 + avatarContainer に 'presenting' クラス追加
   - case 'expression': A2E表情データ処理（フェーズ2で追加、フェーズ1ではスキップ）

3. sendMessage() オーバーライド:
   - 親クラスの簡略化版と同じ（ACK削除済み）
   - 待機アニメーションのタイムアウトを 6500ms に変更
```

### 3.9 chat-controller.ts 変更仕様

```
🚨 変更なし（親クラスの修正に追従するだけ）
currentMode = 'gourmet' の設定とモードスイッチのみ
```

### 3.10 audio-manager.ts 変更仕様

```
🚨 変更なし
audio-streaming-fix-plan.md の修正が既に反映済み:
- キュー方式 PCM 再生 (playPcmAudio)
- scheduledSources 管理
- nextPlayTime スケジューリング
- stopAll() での全ノード停止
- resumeAudioContext() でのiOS復帰
- startStreaming() でのシングルトン AudioWorklet
```

---

## 4. 旧版→新版 移植対応表（原則6）

| 旧版機能 | 旧版ファイル | 新版ファイル | 変更内容 |
|---------|------------|------------|---------|
| セッション開始 | `/api/session/start` (Flask) | `/api/v2/session/start` (FastAPI) | パス変更のみ |
| チャット | `/api/chat` (REST POST) | WebSocket `{type:"text"}` | REST → WebSocket |
| TTS | `/api/tts/synthesize` (Flask) | `/api/v2/rest/tts/synthesize` (FastAPI) | パス変更のみ |
| STT | Socket.IO `audio_chunk` | WebSocket `{type:"audio"}` | フェーズ1では未使用 |
| 通信基盤 | Socket.IO | ネイティブ WebSocket | ライブラリ依存を排除 |
| AI応答 | REST POST → JSON レスポンス | WebSocket ストリーミング | チャンク蓄積方式 |
| ショップ表示 | `data.shops` (REST応答内) | `{type:"shop_data"}` (WebSocket) | 別メッセージで先行送信 |
| 音声再生 | HTMLAudioElement | Web Audio API | iOS受話口問題の解消 |

---

## 5. Astro コンポーネント変更

### GourmetChat.astro

```html
🚨 以下の行を削除する:
<script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>

理由: Socket.IO は使用しない。ネイティブ WebSocket を使用する。
```

### Concierge.astro

```html
🚨 以下の行を削除する:
<script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>

理由: 同上
```

---

## 6. 設定ファイル

### astro.config.mjs プロキシ設定

```javascript
🚨 以下の proxy 設定を維持する（ローカル開発用）

proxy: isDev ? {
  '/api/v2': {
    target: process.env.PUBLIC_API_URL || 'http://localhost:8000',
    changeOrigin: true,
    ws: true,  // 🚨 LiveAPI WebSocket 対応に必須
  },
} : undefined,

🚨 以下の proxy は削除する（Socket.IO 不使用）
// '/api/stt': { ... }
// '/socket.io': { ... }
```

### vercel.json

```json
🚨 WebSocket リライト設定を確認

rewrites に /api/v2/:path* が含まれていること。
🚨 ただし Vercel はネイティブ WebSocket プロキシに制限がある。
WebSocket が必要な場合は NEXT_PUBLIC_WS_URL 等で直接 Cloud Run に接続する必要がある。
```

---

## 7. 検証条件（原則8）

### バックエンド assert

```python
# 1. セッション開始
response = client.post("/api/v2/session/start", json={"language": "ja", "mode": "gourmet"})
assert response.status_code == 200
data = response.json()
assert "session_id" in data
assert data["session_id"].startswith("sess_")
assert "initial_message" in data
assert len(data["initial_message"]) > 0

# 2. session/start は ws_url を返さない
assert "ws_url" not in data

# 3. TTS 合成
response = client.post("/api/v2/rest/tts/synthesize", json={
    "text": "こんにちは", "language_code": "ja-JP", "voice_name": "ja-JP-Chirp3-HD-Leda"
})
assert response.status_code == 200
data = response.json()
assert data["success"] == True
assert len(data["audio"]) > 100

# 4. ヘルスチェック
response = client.get("/health")
assert response.status_code == 200
assert response.json()["status"] == "ok"
```

### フロントエンド assert

```javascript
// 1. WebSocket 接続確認
assert(controller.liveWs !== null, "LiveAPI WebSocket should exist");
assert(controller.liveWs.readyState === WebSocket.OPEN, "WebSocket should be connected");

// 2. テキスト送信のメッセージフォーマット
const testMsg = JSON.parse(lastSentMessage);
assert(testMsg.type === "text", "Message type should be 'text'");
assert("text" in testMsg, "Message should have 'text' field");
assert(!("data" in testMsg), "Message should NOT have 'data' field");

// 3. WebSocket URL 構築
assert(wsUrl.includes("/api/v2/live/"), "WS URL should include /api/v2/live/");
assert(wsUrl.includes(sessionId), "WS URL should include session_id");

// 4. responseBuffer がテキストチャンクを蓄積
// テキストメッセージ受信後:
assert(controller.responseBuffer.length > 0, "Buffer should accumulate text");

// 5. turn_complete 後に responseBuffer がクリア
assert(controller.responseBuffer === "", "Buffer should be cleared after turn_complete");

// 6. preGeneratedAcks が存在しない
assert(!('preGeneratedAcks' in controller), "preGeneratedAcks should not exist");
```

---

## 8. 実装チェックリスト

### バックエンド (support-base/) — 既存コード検証
- [ ] config.py: 設計通りか確認
- [ ] server.py: エンドポイントパスが設計通りか確認
- [ ] server.py: session/start が ws_url を返していないことを確認
- [ ] live/relay.py: フロントエンドメッセージの text フィールド読み取りを確認
- [ ] live/relay.py: Gemini応答の text チャンク送信を確認
- [ ] live/relay.py: tool_call → shop_data 送信フローを確認
- [ ] rest/router.py: TTS エンドポイントが設計通りか確認

### フロントエンド (src/) — 新規実装
- [ ] core-controller.ts: Socket.IO 依存を完全削除
- [ ] core-controller.ts: liveWs プロパティ追加
- [ ] core-controller.ts: responseBuffer プロパティ追加
- [ ] core-controller.ts: connectLiveAPI() メソッド実装
- [ ] core-controller.ts: sendToLive() メソッド実装
- [ ] core-controller.ts: handleLiveMessage() メソッド実装
- [ ] core-controller.ts: initializeSession() を設計通りに修正
- [ ] core-controller.ts: sendMessage() を設計通りに簡略化
- [ ] core-controller.ts: preGeneratedAcks, selectSmartAcknowledgment, generateFallbackResponse 削除
- [ ] concierge-controller.ts: 親クラスの変更に追従
- [ ] chat-controller.ts: 変更なしを確認
- [ ] GourmetChat.astro: Socket.IO CDN 削除
- [ ] Concierge.astro: Socket.IO CDN 削除
- [ ] astro.config.mjs: Socket.IO プロキシ削除、WebSocket プロキシ維持
