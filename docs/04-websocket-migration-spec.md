# 仕様変更書④: Socket.IO → WebSocket 移行

## 基準ソース
- 変更前: gourmet-sp2（③API v2 移行済み）
- 変更後: gourmet-sp2（④本変更）

---

## 変更目的
バックエンド v2 で Socket.IO が廃止され、ネイティブ WebSocket (`/api/v2/live/{session_id}`) に変更されたことに伴い、フロントエンドのリアルタイム通信を Socket.IO → WebSocket に移行する。

---

## 背景

### バックエンド v2 の通信方式変更

| 機能 | 旧 (Socket.IO) | 新 (WebSocket) |
|---|---|---|
| 接続先 | `/socket.io/` | `/api/v2/live/{session_id}` |
| ライブラリ | socket.io-client | ネイティブ WebSocket |
| セッション管理 | Socket.IO イベント | REST `/api/v2/session/start` → WS接続 |
| 音声ストリーミング | `emit('audio_chunk')` | `{"type":"audio","data":"<base64>"}` |
| テキスト送信 | REST `/api/v2/rest/chat` | `{"type":"text","data":"テキスト"}` |
| 停止 | `emit('stop_stream')` | `{"type":"stop"}` |

### v2 WebSocket プロトコル

#### 接続フロー
1. `POST /api/v2/session/start` → `{ session_id, ws_url, greeting }`
2. WebSocket 接続: `wss://<backendUrl>/api/v2/live/{session_id}`

#### クライアント → サーバー (3種類)

| type | data | 説明 |
|---|---|---|
| `audio` | `{ "type": "audio", "data": "<base64 PCM 16kHz>" }` | マイク音声ストリーム |
| `text` | `{ "type": "text", "data": "テキスト入力" }` | テキストチャット |
| `stop` | `{ "type": "stop" }` | セッション終了 |

#### サーバー → クライアント (8種類)

| type | ペイロード | 説明 |
|---|---|---|
| `audio` | `{ data: "<base64 PCM 24kHz>" }` | AI音声（ターン完了時に一括送信） |
| `transcription` | `{ role: "user"\|"ai", text, is_partial }` | 文字起こし |
| `expression` | `{ data: { names, frames, frame_rate, chunk_index, is_final } }` | アバター表情(A2E) |
| `shop_cards` | `{ shops: [...], response: "..." }` | レストラン検索結果 |
| `rest_audio` | `{ data: "<base64 MP3>", text: "..." }` | TTS音声（1軒目解説） |
| `interrupted` | `{}` | 割り込み(barge-in)検知 |
| `reconnecting` | `{ reason: "..." }` | Gemini再接続中 |
| `reconnected` | `{ session_count: N }` | 再接続完了 |
| `error` | `{ message: "..." }` | エラー |

---

## 変更対象ファイル一覧

| ファイル | 変更種別 |
|---|---|
| `src/scripts/chat/core-controller.ts` | 大幅修正（Socket.IO→WebSocket） |
| `src/scripts/chat/concierge-controller.ts` | 大幅修正（Socket.IO→WebSocket + WS受信ハンドラ） |
| `src/scripts/chat/audio-manager.ts` | 修正（socket.emit→WebSocket.send） |
| `vercel.json` | 修正（socket.io rewrite → ws rewrite） |

---

## 1. `core-controller.ts` 変更詳細

### 1.1 プロパティ変更

| 変更前 | 変更後 |
|---|---|
| `protected socket: any = null` | `protected ws: WebSocket \| null = null` |
| （なし） | `protected wsUrl: string = ''` |

### 1.2 `initSocket()` → `initWebSocket(wsUrl)` に変更

**変更前（Socket.IO）:**
```typescript
protected initSocket() {
  const backendUrl = this.container.dataset.backendUrl || window.location.origin;
  this.socket = io(backendUrl, { reconnection: true, ... });
  this.socket.on('connect', () => { });
  this.socket.on('transcript', (data) => { ... });
  this.socket.on('error', (data) => { ... });
}
```

**変更後（WebSocket）:**
```typescript
protected initWebSocket(wsUrl: string) {
  const backendUrl = this.container.dataset.backendUrl || window.location.origin;
  this.wsUrl = wsUrl;
  this.ws = new WebSocket(`${backendUrl.replace(/^http/, 'ws')}${wsUrl}`);

  this.ws.onopen = () => {
    console.log('[WS] Connected');
  };

  this.ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    this.handleWsMessage(msg);
  };

  this.ws.onclose = () => {
    console.log('[WS] Disconnected');
  };

  this.ws.onerror = (err) => {
    console.error('[WS] Error:', err);
  };
}
```

### 1.3 `handleWsMessage(msg)` 新規追加

```typescript
protected handleWsMessage(msg: any) {
  switch (msg.type) {
    case 'transcription':
      if (this.isAISpeaking && msg.role === 'user') return;
      if (msg.role === 'user') {
        if (msg.is_partial) {
          this.els.userInput.value = msg.text;
        } else {
          this.handleStreamingSTTComplete(msg.text);
          this.currentAISpeech = "";
        }
      }
      // AI transcription はサブクラスで処理
      break;
    case 'error':
      this.addMessage('system', `${this.t('sttError')} ${msg.message}`);
      if (this.isRecording) this.stopStreamingSTT();
      break;
  }
}
```

### 1.4 `initializeSession()` 変更

**変更前:** `initSocket()` をコンストラクタで呼び出し → session/start の前に接続

**変更後:** session/start のレスポンスで `ws_url` を取得してから `initWebSocket(ws_url)` を呼び出し

```typescript
// コンストラクタから initSocket() の呼び出しを削除

protected async initializeSession() {
  // ... session/end (既存) ...
  const res = await fetch(`${this.apiBase}/api/v2/session/start`, { ... });
  const data = await res.json();
  this.sessionId = data.session_id;

  // ★ WebSocket接続（session_id取得後）
  this.initWebSocket(data.ws_url);

  // greeting は data.greeting を使用（バックエンドから取得）
  const greetingText = data.greeting || this.t('initialGreeting');
  this.addMessage('assistant', greetingText);
  // ... 以降の処理 ...
}
```

### 1.5 `socket.connected` チェック → `ws.readyState` チェック

| 箇所 | 変更前 | 変更後 |
|---|---|---|
| `toggleRecording()` | `this.socket && this.socket.connected` | `this.ws && this.ws.readyState === WebSocket.OPEN` |
| `stopStreamingSTT()` | `this.socket && this.socket.connected` → `socket.emit('stop_stream')` | `this.wsSend({ type: 'stop' })` |
| `stopAllActivities()` | `this.socket && this.socket.connected` → `socket.emit('stop_stream')` | `this.wsSend({ type: 'stop' })` |
| Foreground handler | `this.socket.connect()` | WebSocket再接続ロジック |

### 1.6 `wsSend()` ヘルパー新規追加

```typescript
protected wsSend(msg: object) {
  if (this.ws && this.ws.readyState === WebSocket.OPEN) {
    this.ws.send(JSON.stringify(msg));
  }
}
```

### 1.7 `sendMessage()` 変更

**変更前:** REST `/api/v2/rest/chat` にPOST → レスポンスから応答テキスト・shop情報取得

**変更後:** WebSocket で `{ type: "text", data: "メッセージ" }` を送信。応答はWS受信ハンドラで処理。

```typescript
// sendMessage() 内
this.wsSend({ type: 'text', data: message });
// 応答は handleWsMessage() 経由で受信
```

### 1.8 `speakTextGCP()` 変更

**変更前:** REST `/api/v2/rest/tts/synthesize` にPOST → base64 MP3再生

**変更後:** AI音声は WebSocket の `audio` メッセージで受信（PCM 24kHz base64）。ack音声のみ REST TTS を維持。

### 1.9 Foreground復帰時のWebSocket再接続

**変更前:** `this.socket.connect()`

**変更後:** WebSocket は再接続メソッドなし → 新しい WebSocket インスタンスを作成。ただしバックエンドが `reconnecting` / `reconnected` メッセージを送信するため、基本的にはバックエンド側で管理。クライアント側は `ws.onclose` で自動再接続を試行。

---

## 2. `concierge-controller.ts` 変更詳細

### 2.1 `initSocket()` オーバーライド削除

ConciergeController の `initSocket()` オーバーライドを削除。`initWebSocket()` は CoreController のものをそのまま使用。

### 2.2 `handleWsMessage()` オーバーライド

ConciergeController 固有のWS受信処理を追加:

```typescript
protected handleWsMessage(msg: any) {
  super.handleWsMessage(msg);  // transcription, error は親で処理

  switch (msg.type) {
    case 'audio':
      // AI音声再生（PCM 24kHz base64）
      this.playPcmAudio(msg.data);
      break;
    case 'expression':
      // アバター表情データ適用
      this.applyExpressionFromTts(msg.data);
      break;
    case 'shop_cards':
      // ショップカード表示
      this.handleShopCards(msg);
      break;
    case 'rest_audio':
      // TTS音声（1軒目解説）再生
      this.playRestAudio(msg);
      break;
    case 'interrupted':
      // barge-in: 再生停止
      this.stopCurrentAudio();
      break;
    case 'transcription':
      if (msg.role === 'ai' && !msg.is_partial) {
        // AI応答テキスト表示
        this.addMessage('assistant', msg.text);
      }
      break;
  }
}
```

### 2.3 `sendMessage()` 簡素化

**変更前:** REST POST → レスポンス解析 → TTS → ショップカード

**変更後:** WebSocket送信のみ。応答は全て `handleWsMessage()` で受信処理。

---

## 3. `audio-manager.ts` 変更詳細

### 3.1 `startStreaming()` インターフェース変更

**変更前:** `socket: any` を受け取り、`socket.emit()` で送信

**変更後:** `ws: WebSocket` を受け取り、`ws.send()` で送信

| 変更前 | 変更後 |
|---|---|
| `socket.emit('start_stream', { language_code, sample_rate })` | 不要（WS接続＝ストリーム開始） |
| `socket.emit('audio_chunk', { chunk, sample_rate })` | `ws.send(JSON.stringify({ type: 'audio', data: base64 }))` |
| `socket.emit('stop_stream')` | `ws.send(JSON.stringify({ type: 'stop' }))` |
| `socket.once('stream_ready', ...)` | 不要（WS接続済み＝送信可能） |
| `socket && socket.connected` | `ws && ws.readyState === WebSocket.OPEN` |

### 3.2 `stream_ready` 待機の削除

Socket.IO では `start_stream` → `stream_ready` の待機が必要だったが、WebSocket ではWS接続済み＝送信可能のため、この待機ロジックを削除。

---

## 4. `vercel.json` 変更詳細

**変更前:**
```json
{
  "source": "/socket.io/:path*",
  "destination": "https://support-base-hhasiuut7q-uc.a.run.app/socket.io/:path*"
}
```

**変更後:**
```json
{
  "source": "/api/v2/live/:path*",
  "destination": "https://support-base-hhasiuut7q-uc.a.run.app/api/v2/live/:path*"
}
```

**注意:** Vercel rewrites は WebSocket をプロキシできない可能性がある。その場合、WebSocket接続は `backendUrl` を使って直接接続する（Socket.IOと同様の方式）。

---

## 5. Socket.IO → WebSocket 対応表（まとめ）

### クライアント → サーバー

| Socket.IO (旧) | WebSocket (新) | 用途 |
|---|---|---|
| `emit('start_stream', {language_code, sample_rate})` | 不要（WS接続＝開始） | ストリーム開始 |
| `emit('audio_chunk', {chunk, sample_rate})` | `send({type:'audio', data:base64})` | 音声チャンク |
| `emit('stop_stream')` | `send({type:'stop'})` | ストリーム停止 |
| REST `/api/v2/rest/chat` POST | `send({type:'text', data:text})` | テキスト送信 |

### サーバー → クライアント

| Socket.IO (旧) | WebSocket (新) | 用途 |
|---|---|---|
| `on('transcript', {text, is_final})` | `transcription: {role, text, is_partial}` | 音声認識結果 |
| `on('error', {message})` | `error: {message}` | エラー |
| `on('stream_ready')` | 不要 | ストリーム準備完了 |
| REST response `data.response` | `transcription: {role:'ai', text}` | AI応答テキスト |
| REST response `data.shops` | `shop_cards: {shops, response}` | ショップ情報 |
| REST TTS response `data.audio` | `audio: {data}` | AI音声 |
| REST TTS response `data.expression` | `expression: {data}` | 表情データ |
| （なし） | `interrupted: {}` | barge-in |
| （なし） | `reconnecting: {reason}` | 再接続中 |
| （なし） | `reconnected: {session_count}` | 再接続完了 |

---

## 6. 接続方式の整理（④以降）

| 通信種別 | 接続先 | 方式 |
|---|---|---|
| REST API（session/start, session/end, tts/synthesize, cancel） | same-origin (`apiBase=''`) | Vercel rewrites 経由 |
| WebSocket（音声ストリーム、テキストチャット、全リアルタイム通信） | `backendUrl` に直接接続 | ネイティブ WebSocket |

---

## 7. ロジック変更

- Socket.IO ライブラリ依存の削除（`io()` 呼び出し廃止）
- WebSocket 接続タイミング: コンストラクタ → `initializeSession()` 内（session_id取得後）
- `sendMessage()`: REST POST → WebSocket テキスト送信
- AI応答・音声・表情: REST レスポンス → WebSocket 受信ハンドラ
- `stream_ready` 待機ロジックの削除
- 音声形式: 受信時 MP3 base64 → PCM 24kHz base64（再生方法の変更が必要）
