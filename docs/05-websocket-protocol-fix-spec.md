# 仕様変更書⑤: WebSocket プロトコル修正 + リップシンク対応

## 基準ソース
- 変更前: gourmet-sp2（④WS移行済み — ただしプロトコル不整合あり）
- 変更後: gourmet-sp2（⑤本変更 — バックエンド仕様準拠 + リップシンク対応）
- 参照: support-base `docs/FRONTEND_WEBSOCKET_SPEC.md` (v2.0)
- 参照: support-base `docs/FRONTEND_LIPSYNC_SPEC.md` (v2.0)

---

## 変更目的

④の WebSocket 移行で Socket.IO プロトコルをそのまま WebSocket に移植してしまった結果、バックエンドの期待するプロトコルと不整合が生じている。本変更でバックエンド WS 仕様に完全準拠させ、同時にリップシンク（A2E 表情同期）を正しく実装する。

---

## コードベース前提知識（実装者は必ず読むこと）

### DOM要素の参照方法

`core-controller.ts` L53-68 で DOM 要素を `this.els` にキャッシュしている:

```typescript
// core-controller.ts L53-68（変更しない）
const query = (sel: string) => container.querySelector(sel) as HTMLElement;
this.els = {
  chatArea: query('#chatArea'),           // ← チャット表示エリア。chatMessagesではない。
  userInput: query('#userInput') as HTMLInputElement,
  sendBtn: query('#sendBtn'),
  micBtn: query('#micBtnFloat'),
  speakerBtn: query('#speakerBtnFloat'),
  voiceStatus: query('#voiceStatus'),
  waitOverlay: query('#waitOverlay'),
  waitVideo: query('#waitVideo') as HTMLVideoElement,
  splashOverlay: query('#splashOverlay'),
  splashVideo: query('#splashVideo') as HTMLVideoElement,
  reservationBtn: query('#reservationBtnFloat'),
  stopBtn: query('#stopBtn'),
  languageSelect: query('#languageSelect') as HTMLSelectElement
};
```

concierge-controller.ts L32-35 で追加要素を登録:
```typescript
// concierge-controller.ts L32-35（変更しない）
this.els.avatarContainer = query('.avatar-container');
this.els.avatarImage = query('#avatarImage') as HTMLImageElement;
this.els.modeSwitch = query('#modeSwitch') as HTMLInputElement;
```

### `addMessage()` の DOM 構造

```typescript
// core-controller.ts L986-994（変更しない）
protected addMessage(role: string, text: string, summary: string | null = null, isInitial: boolean = false) {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  if (isInitial) div.setAttribute('data-initial', 'true');
  let contentHtml = `<div class="message-content"><span class="message-text">${text}</span></div>`;
  div.innerHTML = `<div class="message-avatar">${role === 'assistant' ? '🍽' : '👤'}</div>${contentHtml}`;
  this.els.chatArea.appendChild(div);          // ← this.els.chatArea
  this.els.chatArea.scrollTop = this.els.chatArea.scrollHeight;
}
```

生成される DOM:
```html
<div class="message assistant">
  <div class="message-avatar">🍽</div>
  <div class="message-content">
    <span class="message-text">テキスト</span>
  </div>
</div>
```

### `window.lamAvatarController` の参照

TypeScript では `window` に未定義のプロパティを直接参照できない。必ず `(window as any).lamAvatarController` を使うこと。

### `els` の型

`this.els` は `any` 型（L37: `protected els: any = {};`）。型安全性はない。

---

## 現状の問題点一覧

### A. 送信プロトコルの不整合

| # | 箇所 | 現在の実装 (NG) | バックエンド仕様 (正) |
|---|------|----------------|---------------------|
| A1 | テキスト送信 (core) | `{type:"text", session_id, message, stage, language, mode}` | `{type:"text", data:"メッセージ"}` |
| A2 | テキスト送信 (concierge) | REST `POST /api/v2/rest/chat` | `{type:"text", data:"メッセージ"}` |
| A3 | 音声チャンク送信 | `{type:"audio_chunk", chunk, sample_rate:16000}` | `{type:"audio", data:"<base64>"}` |
| A4 | ストリーム開始 | `{type:"start_stream", language_code, sample_rate}` | **不要**（WS接続＝送信可能） |
| A5 | ストリーム停止 | `{type:"stop_stream"}` | **不要**（音声を送らなければ良い） |

### B. 受信処理の問題

| # | 箇所 | 現在の実装 (NG) | バックエンド仕様 (正) |
|---|------|----------------|---------------------|
| B1 | AI応答テキスト (core) | `is_partial` 無視、final のみ表示 | `is_partial:true` → 上書き表示、`false` → 確定置換 |
| B2 | AI応答テキスト (concierge) | REST応答の `data.response` | WS `transcription(role:ai)` で受信 |
| B3 | ショップ結果 (concierge) | REST応答の `data.shops` | WS `shop_cards` メッセージで受信 |
| B4 | AI音声 (concierge) | REST `/api/v2/rest/tts/synthesize` → MP3 | WS `audio` → PCM 24kHz |
| B5 | 表情データ同期 | `expression` 受信 → 即適用 | `audio` + `expression` 両方揃ったら同時再生 |
| B6 | `reconnecting` UI | `console.log` のみ | 「接続中...」インジケーター表示 |

### C. 不要なコードの残留

| # | 内容 |
|---|------|
| C1 | concierge `sendMessage()` 内の REST chat 呼び出し（200行超） |
| C2 | concierge `sendMessage()` 内の REST TTS 並列リクエスト |
| C3 | concierge `speakResponseInChunks()` — REST TTS で分割再生 |
| C4 | core `sendMessage()` 内のフォールバック応答生成 |
| C5 | core `handleStreamingSTTComplete()` 内のフォールバック応答生成 |
| C6 | audio-manager の `start_stream` / `stop_stream` 送信 |

---

## 変更対象ファイル一覧

| ファイル | 変更種別 | 影響範囲 |
|---|---|---|
| `src/scripts/chat/audio-manager.ts` | 修正 | 音声送信プロトコル |
| `src/scripts/chat/core-controller.ts` | 修正 | テキスト送信 + 受信ハンドラ + 停止処理 |
| `src/scripts/chat/concierge-controller.ts` | 大幅修正 | sendMessage REST→WS + 表情同期 |

---

## 1. `audio-manager.ts` 変更詳細

### 1.1 音声チャンク送信フォーマット変更 (A3)

2箇所で同一の変更を行う。

**箇所1: `startStreaming_iOS()` 内 onmessage ハンドラ**

検索文字列:
```typescript
ws.send(JSON.stringify({ type: 'audio_chunk', chunk: base64, sample_rate: 16000 }));
```

置換文字列:
```typescript
ws.send(JSON.stringify({ type: 'audio', data: base64 }));
```

**箇所2: `startStreaming_Default()` 内 onmessage ハンドラ**

同一の検索文字列・置換文字列で置換する。

**確認:** ファイル内に `audio_chunk` が0件であること。

### 1.2 `start_stream` 送信の削除 (A4)

2箇所で同一パターンの変更を行う。

**箇所1: `startStreaming_iOS()` 内**

検索文字列（4行）:
```typescript
      // ★STEP4: start_stream送信（バックエンドにSTT設定を通知）
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'start_stream', language_code: languageCode, sample_rate: 16000 }));
      }

      // ★STEP5: 送信許可（start_stream送信後）
      this.canSendAudio = true;
```

置換文字列:
```typescript
      // WS接続済み＝音声送信可能（start_stream不要）
      this.canSendAudio = true;
```

**箇所2: `startStreaming_Default()` 内**

同一の検索文字列・置換文字列で置換する。

**確認:** ファイル内に `start_stream` が0件であること（コメント「start_stream不要」は除く）。

### 1.3 `startStreaming()` の `languageCode` 引数

`start_stream` 削除に伴い、`languageCode` 引数は不要になるが、**シグネチャは変更しない**（呼び出し側の変更を最小化）。内部で使わないだけ。

---

## 2. `core-controller.ts` 変更詳細

### 2.1 テキスト送信フォーマット修正 (A1)

**対象:** `sendMessage()` 内の `this.wsSend()` 呼び出し

検索文字列:
```typescript
    // ★ WebSocket経由でテキスト送信
    this.wsSend({
      type: 'text',
      session_id: this.sessionId,
      message: message,
      stage: this.currentStage,
      language: this.currentLanguage,
      mode: this.currentMode
    });
```

置換文字列:
```typescript
    // ★ WebSocket経由でテキスト送信（バックエンド仕様準拠）
    this.wsSend({ type: 'text', data: message });
```

**理由:** バックエンドは `session_id` を WS URL から取得済み。`stage` / `language` / `mode` もセッション開始時に設定済み。

### 2.2 `stopStreamingSTT()` から `stop_stream` 送信を削除 (A5, 箇所1/2)

**対象:** `stopStreamingSTT()` メソッド

検索文字列:
```typescript
  protected stopStreamingSTT() {
    this.audioManager.stopStreaming();
    this.wsSend({ type: 'stop_stream' });
    this.isRecording = false;
```

置換文字列:
```typescript
  protected stopStreamingSTT() {
    this.audioManager.stopStreaming();
    // stop_stream 不要: 音声チャンク送信を止めればバックエンドが自動的にSTT完了を検知
    this.isRecording = false;
```

### 2.3 `stopAllActivities()` から `stop_stream` 送信を削除 (A5, 箇所2/2)

**対象:** `stopAllActivities()` メソッド

検索文字列:
```typescript
    this.audioManager.fullResetAudioResources();
    this.isRecording = false;
    this.els.micBtn.classList.remove('recording');
    this.wsSend({ type: 'stop_stream' });
    this.stopCurrentAudio();
```

置換文字列:
```typescript
    this.audioManager.fullResetAudioResources();
    this.isRecording = false;
    this.els.micBtn.classList.remove('recording');
    this.stopCurrentAudio();
```

**確認:** ファイル内に `stop_stream` が0件であること（コメント除く）。

### 2.4 AI応答テキスト: partial 表示対応 (B1)

**対象:** `handleWsMessage()` の `msg.role === 'ai'` 分岐

検索文字列:
```typescript
        } else if (msg.role === 'ai') {
          if (!msg.is_partial) {
            this.hideWaitOverlay();
            this.currentAISpeech = msg.text;
            this.addMessage('assistant', msg.text);
            this.resetInputState();
          }
        }
```

置換文字列:
```typescript
        } else if (msg.role === 'ai') {
          this.hideWaitOverlay();
          if (msg.is_partial) {
            // ストリーミング表示: 部分テキストで上書き
            this.updateStreamingMessage('assistant', msg.text);
          } else {
            // 確定: 確定テキストに置換
            this.finalizeStreamingMessage('assistant', msg.text);
            this.currentAISpeech = msg.text;
            this.resetInputState();
          }
        }
```

### 2.5 新規メソッド追加: `updateStreamingMessage`, `finalizeStreamingMessage`

**挿入位置:** `wsSend()` メソッドの直後（`wsSend` の閉じ `}` の次の空行）

検索文字列:
```typescript
  // ★ WebSocket送信ヘルパー
  protected wsSend(msg: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
```

置換文字列:
```typescript
  // ★ WebSocket送信ヘルパー
  protected wsSend(msg: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ストリーミング中のメッセージを更新（末尾の吹き出しのテキストを上書き）
  // 注意: DOM要素は this.els.chatArea（this.els.chatMessages ではない）
  // 注意: テキスト要素は .message-content > .message-text（addMessage() L991 参照）
  protected updateStreamingMessage(role: string, partialText: string) {
    const messages = this.els.chatArea.querySelectorAll(`.message.${role}`);
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.classList.contains('streaming')) {
      const content = lastMsg.querySelector('.message-content') || lastMsg.querySelector('.message-text');
      if (content) content.textContent = partialText;
    } else {
      this.addMessage(role, partialText);
      const newMessages = this.els.chatArea.querySelectorAll(`.message.${role}`);
      const newMsg = newMessages[newMessages.length - 1];
      if (newMsg) newMsg.classList.add('streaming');
    }
  }

  // ストリーミング完了 → 確定テキストに置換
  protected finalizeStreamingMessage(role: string, finalText: string) {
    const messages = this.els.chatArea.querySelectorAll(`.message.${role}`);
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.classList.contains('streaming')) {
      const content = lastMsg.querySelector('.message-content') || lastMsg.querySelector('.message-text');
      if (content) content.textContent = finalText;
      lastMsg.classList.remove('streaming');
    } else {
      this.addMessage(role, finalText);
    }
  }
```

**動作説明:**
- `updateStreamingMessage`: バックエンドから `is_partial:true` のテキストが来るたびに呼ばれる。バックエンドは **累積テキスト** を送信するため、`textContent` を上書き（追記ではない）する。初回は `addMessage()` で吹き出しを作成し、`streaming` クラスを付与。
- `finalizeStreamingMessage`: `is_partial:false` の確定テキストが来たら呼ばれる。`streaming` クラスを除去し、テキストを確定値で上書き。

### 2.6 `reconnecting` / `reconnected` の UI 表示 (B6)

**対象:** `handleWsMessage()` 内

検索文字列:
```typescript
      case 'reconnecting':
        console.log('[WS] Reconnecting:', msg.reason);
        break;
      case 'reconnected':
        console.log('[WS] Reconnected, session count:', msg.session_count);
        break;
```

置換文字列:
```typescript
      case 'reconnecting':
        console.log('[WS] Reconnecting:', msg.reason);
        this.showReconnectingUI();
        break;
      case 'reconnected':
        console.log('[WS] Reconnected, session count:', msg.session_count);
        this.hideReconnectingUI();
        break;
```

### 2.7 新規メソッド追加: `showReconnectingUI`, `hideReconnectingUI`

**挿入位置:** `finalizeStreamingMessage()` の直後

```typescript
  // 再接続中UI表示
  protected showReconnectingUI() {
    this.els.voiceStatus.innerHTML = this.t('reconnecting') || '接続中...';
    this.els.voiceStatus.className = 'voice-status reconnecting';
  }

  // 再接続完了UI復帰
  protected hideReconnectingUI() {
    this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
    this.els.voiceStatus.className = 'voice-status stopped';
  }
```

**注意:** `showReconnectingUI()` は引数なし。`msg.reason` は `console.log` のみで使用し、UIには渡さない。

### 2.8 `sendMessage()` 内フォールバック応答の削除 (C4)

**対象:** `sendMessage()` 内、ack再生後のフォールバック応答

検索文字列:
```typescript
      if (firstAckPromise) await firstAckPromise;

      const cleanText = this.removeFillers(message);
      const fallbackResponse = this.generateFallbackResponse(cleanText);

      if (this.isTTSEnabled && this.isUserInteracted) await this.speakTextGCP(fallbackResponse, false, false, isTextInput);
      this.addMessage('assistant', fallbackResponse);

      setTimeout(async () => {
        const additionalResponse = this.t('additionalResponse');
        if (this.isTTSEnabled && this.isUserInteracted) await this.speakTextGCP(additionalResponse, false, false, isTextInput);
        this.addMessage('assistant', additionalResponse);
      }, 3000);
    }
```

置換文字列:
```typescript
      if (firstAckPromise) await firstAckPromise;
    }
```

**理由:** テキスト入力時もバックエンドに WS 送信するため、フォールバック応答は不要。バックエンドの `transcription(role:ai)` で正式な応答が返ってくる。

### 2.9 `handleStreamingSTTComplete()` 内フォールバック応答の削除 (C5)

**対象:** `handleStreamingSTTComplete()` 内の即時実行関数

検索文字列（L664-689）:
```typescript
    (async () => {
      try {
        if (firstAckPromise) await firstAckPromise;
        const cleanText = this.removeFillers(transcript);
        const fallbackResponse = this.generateFallbackResponse(cleanText);

        if (this.isTTSEnabled && this.isUserInteracted) await this.speakTextGCP(fallbackResponse, false);
        this.addMessage('assistant', fallbackResponse);

        setTimeout(async () => {
          const additionalResponse = this.t('additionalResponse');
          if (this.isTTSEnabled && this.isUserInteracted) await this.speakTextGCP(additionalResponse, false);
          this.addMessage('assistant', additionalResponse);
        }, 3000);

        if (this.els.userInput.value.trim()) {
          this.isFromVoiceInput = true;
          this.sendMessage();
        }
      } catch (_error) {
        if (this.els.userInput.value.trim()) {
          this.isFromVoiceInput = true;
          this.sendMessage();
        }
      }
    })();
```

置換文字列:
```typescript
    (async () => {
      if (firstAckPromise) await firstAckPromise;
      if (this.els.userInput.value.trim()) {
        this.isFromVoiceInput = true;
        this.sendMessage();
      }
    })();
```

**理由:** `sendMessage()` → WS テキスト送信 → バックエンド応答のフローに統一。フォールバック応答は二重表示の原因。

---

## 3. `concierge-controller.ts` 変更詳細

### 3.1 プロパティ追加（B5: 同期再生用バッファ）

**対象:** クラス宣言冒頭のプロパティ

検索文字列:
```typescript
export class ConciergeController extends CoreController {
  // Audio2Expression はバックエンドTTSエンドポイント経由で統合済み
  private pendingAckPromise: Promise<void> | null = null;
```

置換文字列:
```typescript
export class ConciergeController extends CoreController {
  // Audio2Expression はバックエンドTTSエンドポイント経由で統合済み
  private pendingAckPromise: Promise<void> | null = null;
  // B5: audio + expression 同期再生用バッファ
  private pendingLiveAudio: string | null = null;
  private pendingExpression: any = null;
  private expressionWaitTimer: ReturnType<typeof setTimeout> | null = null;
```

**型について:** `pendingExpression` は `any` 型とする。`ExpressionData` 等の型定義は不要。

### 3.2 `handleWsMessage()` 全体書き換え

**対象:** concierge の `handleWsMessage()` メソッド全体

検索文字列（メソッド全体）:
```typescript
  protected handleWsMessage(msg: any) {
    switch (msg.type) {
      case 'expression':
        // アバター表情データ適用
        this.applyExpressionFromTts(msg.data);
        break;
      case 'audio':
        // AI音声（PCM 24kHz）with アバターアニメーション
        this.isAISpeaking = true;
        if (this.els.avatarContainer) this.els.avatarContainer.classList.add('speaking');
        this.playPcmAudioWithAvatar(msg.data);
        break;
      case 'rest_audio':
        // TTS音声（MP3）with アバターアニメーション
        this.isAISpeaking = true;
        if (this.isRecording) this.stopStreamingSTT();
        if (this.els.avatarContainer) this.els.avatarContainer.classList.add('speaking');
        if (msg.text) this.lastAISpeech = this.normalizeText(msg.text);
        this.stopCurrentAudio();
        this.ttsPlayer.src = `data:audio/mp3;base64,${msg.data}`;
        this.ttsPlayer.onended = () => {
          this.isAISpeaking = false;
          this.stopAvatarAnimation();
          this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
          this.els.voiceStatus.className = 'voice-status stopped';
        };
        this.ttsPlayer.onerror = () => {
          this.isAISpeaking = false;
          this.stopAvatarAnimation();
        };
        this.els.voiceStatus.innerHTML = this.t('voiceStatusSpeaking');
        this.els.voiceStatus.className = 'voice-status speaking';
        if (this.isUserInteracted) {
          this.ttsPlayer.play().catch(() => {
            this.isAISpeaking = false;
            this.stopAvatarAnimation();
          });
        } else {
          this.isAISpeaking = false;
          this.stopAvatarAnimation();
        }
        break;
      case 'interrupted':
        // barge-in: 再生停止 + アバター停止
        this.stopCurrentAudio();
        this.isAISpeaking = false;
        this.stopAvatarAnimation();
        break;
      default:
        // transcription, shop_cards, error, reconnecting, reconnected は親クラスで処理
        super.handleWsMessage(msg);
        break;
    }
  }
```

置換文字列:
```typescript
  protected handleWsMessage(msg: any) {
    switch (msg.type) {
      case 'audio':
        // B5: AI音声（PCM 24kHz）— expressionと同期再生するためバッファリング
        this.isAISpeaking = true;
        if (this.els.avatarContainer) this.els.avatarContainer.classList.add('speaking');
        this.pendingLiveAudio = msg.data;
        this._tryStartSyncedPlayback();
        // expressionが来ない場合のフォールバック（200ms待ち）
        this.expressionWaitTimer = setTimeout(() => {
          if (this.pendingLiveAudio) {
            this.playPcmAudioWithAvatar(this.pendingLiveAudio);
            this.pendingLiveAudio = null;
          }
        }, 200);
        break;
      case 'expression':
        // B5: アバター表情データ — audioと同期再生するためバッファリング
        this.pendingExpression = msg.data;
        if (this.expressionWaitTimer) {
          clearTimeout(this.expressionWaitTimer);
          this.expressionWaitTimer = null;
        }
        this._tryStartSyncedPlayback();
        break;
      case 'rest_audio':
        // TTS音声（MP3）with アバターアニメーション（expressionを伴わない）
        this.isAISpeaking = true;
        if (this.isRecording) this.stopStreamingSTT();
        if (this.els.avatarContainer) this.els.avatarContainer.classList.add('speaking');
        if (msg.text) this.lastAISpeech = this.normalizeText(msg.text);
        this.stopCurrentAudio();
        this.ttsPlayer.src = `data:audio/mp3;base64,${msg.data}`;
        this.ttsPlayer.onended = () => {
          this.isAISpeaking = false;
          this.stopAvatarAnimation();
          this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
          this.els.voiceStatus.className = 'voice-status stopped';
        };
        this.ttsPlayer.onerror = () => {
          this.isAISpeaking = false;
          this.stopAvatarAnimation();
        };
        this.els.voiceStatus.innerHTML = this.t('voiceStatusSpeaking');
        this.els.voiceStatus.className = 'voice-status speaking';
        if (this.isUserInteracted) {
          this.ttsPlayer.play().catch(() => {
            this.isAISpeaking = false;
            this.stopAvatarAnimation();
          });
        } else {
          this.isAISpeaking = false;
          this.stopAvatarAnimation();
        }
        break;
      case 'shop_cards':
        // 親クラスでカード表示 + テキスト表示
        super.handleWsMessage(msg);
        // アバター側: 店舗紹介モードに遷移
        if (this.els.avatarContainer) this.els.avatarContainer.classList.add('presenting');
        break;
      case 'interrupted':
        // barge-in: 再生停止 + アバター停止 + 表情リセット
        this.stopCurrentAudio();
        this.isAISpeaking = false;
        this.stopAvatarAnimation();
        // 表情を中立にリセット（TypeScript: windowはanyキャスト必須）
        if ((window as any).lamAvatarController?.clearFrameBuffer) {
          (window as any).lamAvatarController.clearFrameBuffer();
        }
        // ペンディングデータもクリア
        this.pendingLiveAudio = null;
        this.pendingExpression = null;
        if (this.expressionWaitTimer) {
          clearTimeout(this.expressionWaitTimer);
          this.expressionWaitTimer = null;
        }
        break;
      default:
        // transcription, error, reconnecting, reconnected は親クラスで処理
        super.handleWsMessage(msg);
        break;
    }
  }
```

**変更点まとめ:**
1. `audio`: 即再生 → `pendingLiveAudio` にバッファリング + 200ms タイマー
2. `expression`: 即適用 → `pendingExpression` にバッファリング + タイマーキャンセル
3. `shop_cards`: `default` 任せ → 明示的に `case` 追加、`super` 後にアバター `presenting` クラス付与
4. `interrupted`: 表情リセット + ペンディングクリア追加
5. case の順序: `audio` → `expression` → `rest_audio` → `shop_cards` → `interrupted` → `default`

### 3.3 新規メソッド追加: `_tryStartSyncedPlayback`

**挿入位置:** `handleWsMessage()` の閉じ `}` の直後

```typescript
  // B5: audio + expression が両方揃ったら同時再生開始
  private _tryStartSyncedPlayback() {
    if (this.pendingLiveAudio && this.pendingExpression) {
      // 表情フレームをアバターにキューイング（音声と同時スタートで自動同期）
      this.applyExpressionFromTts(this.pendingExpression);
      // 音声再生開始
      this.playPcmAudioWithAvatar(this.pendingLiveAudio);
      this.pendingLiveAudio = null;
      this.pendingExpression = null;
    }
  }
```

**動作フロー:**
```
パターン1: audio → expression（通常）
  audio受信 → pendingLiveAudio格納 + 200msタイマー開始 + _tryStartSyncedPlayback(何もしない)
  expression受信(200ms以内) → pendingExpression格納 + タイマーキャンセル + _tryStartSyncedPlayback(両方揃った→同時再生)

パターン2: expression → audio（稀）
  expression受信 → pendingExpression格納 + _tryStartSyncedPlayback(何もしない)
  audio受信 → pendingLiveAudio格納 + 200msタイマー開始 + _tryStartSyncedPlayback(両方揃った→同時再生)

パターン3: audioのみ（expression来ない）
  audio受信 → pendingLiveAudio格納 + 200msタイマー開始
  200ms経過 → タイマー発火 → 音声のみ再生
```

### 3.4 `sendMessage()` の REST → WS 移行 (A2, C1, C2)

**対象:** `sendMessage()` メソッドの後半部分

検索文字列（ack再生後〜メソッド末尾）:
```typescript
    // ✅ 待機アニメーションは6.5秒後に表示(LLM送信直前にタイマースタート)
    if (this.waitOverlayTimer) clearTimeout(this.waitOverlayTimer);
    let responseReceived = false;

    this.waitOverlayTimer = window.setTimeout(() => {
      if (!responseReceived) {
        this.showWaitOverlay();
      }
    }, 6500);

    try {
      const response = await fetch(`${this.apiBase}/api/v2/rest/chat`, {
```
…（ここから `} finally {` まで約200行のREST処理）…
```typescript
    } finally {
      this.resetInputState();
      this.els.userInput.blur();
    }
  }
```

置換文字列:
```typescript
    // ✅ 待機アニメーションは6.5秒後に表示
    if (this.waitOverlayTimer) clearTimeout(this.waitOverlayTimer);
    this.waitOverlayTimer = window.setTimeout(() => { this.showWaitOverlay(); }, 6500);

    // ★ WebSocket経由でテキスト送信（REST不要）
    this.wsSend({ type: 'text', data: message });
    this.els.userInput.blur();
    // レスポンスは handleWsMessage() で処理（transcription, audio, expression, shop_cards, rest_audio）
  }
```

**削除されるもの:**
- `let responseReceived = false;`
- `fetch(\`${this.apiBase}/api/v2/rest/chat\`, ...)` 呼び出し
- REST レスポンス解析 (`data.response`, `data.shops`)
- REST TTS 並列リクエスト (`/api/v2/rest/tts/synthesize` x 2)
- ショップ紹介音声の手動組み立て
- `speakResponseInChunks()` の呼び出し
- `extractShopsFromResponse()` の呼び出し
- `try/catch/finally` ブロック

### 3.5 `speakResponseInChunks()` + `splitIntoSentences()` 削除 (C3)

**対象:** 2つのメソッド全体を削除

検索文字列（メソッド先頭）:
```typescript
  private splitIntoSentences(text: string, language: string): string[] {
```
〜
検索文字列（メソッド末尾）:
```typescript
      await this.speakTextGCP(response, true, false, isTextInput);
    }
  }
```

この2メソッド（`splitIntoSentences` + `speakResponseInChunks`）を丸ごと削除する。

**確認:** ファイル内に `speakResponseInChunks` が0件であること。

### 3.6 `speakTextGCP()` の役割変更

**変更なし。** メソッドはそのまま残す。用途が変わるだけ:

| 変更前 | 変更後 |
|--------|--------|
| AI応答音声の主要な再生手段 | ack音声・shortMsgWarning専用 |

AI応答音声は WS `audio` メッセージで受信・再生される。

---

## 4. 音声フォーマット整理

| 方向 | 形式 | サンプルレート | 用途 |
|------|------|-------------|------|
| **送信** (マイク→サーバー) | PCM 16bit mono base64 | 16kHz | STT用 |
| **受信** `audio` | PCM 16bit mono base64 | 24kHz | AI音声 (Gemini Live) |
| **受信** `rest_audio` | MP3 base64 | — | 店舗紹介TTS |
| **ローカル** ack/intro | MP3 base64 | — | プリ生成済み即答 |

---

## 5. 変更の優先順位

| 優先度 | 変更 | 影響 |
|--------|------|------|
| **P0 (必須)** | A1: core テキスト送信 `{type:"text", data}` | テキストチャットが動かない |
| **P0 (必須)** | A3: 音声チャンク `{type:"audio", data}` | 音声認識が動かない |
| **P0 (必須)** | A4: `start_stream` 削除 | 不明なメッセージでエラーの可能性 |
| **P0 (必須)** | A2: concierge sendMessage WS 化 | concierge テキストチャットが動かない |
| **P1 (重要)** | A5: `stop_stream` 削除（2箇所） | 不明なメッセージ送信 |
| **P1 (重要)** | B5: audio + expression 同期再生 | リップシンクの音ズレ |
| **P1 (重要)** | C4+C5: フォールバック応答削除（2箇所） | 二重応答表示 |
| **P2 (改善)** | B1: AI partial テキスト表示 | ストリーミング UX |
| **P2 (改善)** | B6: reconnecting UI | 再接続時の UX |
| **P3 (整理)** | C3: speakResponseInChunks 削除 | コード整理 |

---

## 6. 実装後チェックリスト

### ビルド確認
- [ ] `npm run build` がエラー0件で成功すること

### grep 確認（残骸がないこと）
- [ ] `audio_chunk` → 0件
- [ ] `start_stream` → コメントのみ
- [ ] `stop_stream` → コメントのみ
- [ ] `speakResponseInChunks` → 0件
- [ ] `chatMessages` → 0件（`chatArea` を使うこと）
- [ ] `session_id.*message.*stage.*language.*mode` → 0件（WS テキスト送信は `{type:"text", data}` のみ）
- [ ] `api/v2/rest/chat` → 0件（REST chat 呼び出しは削除済み）

### テスト計画

#### テキストチャット
- [ ] テキスト入力 → WS `{type:"text", data}` 送信確認（DevTools Network → WS frames）
- [ ] AI `transcription(role:ai, is_partial:true)` → チャットエリアにストリーミング表示（1つの吹き出しが更新される）
- [ ] AI `transcription(role:ai, is_partial:false)` → 確定テキストに置換、`streaming` クラスが除去される
- [ ] `shop_cards` 受信 → カード表示 + アバターに `presenting` クラス付与

#### 音声入力
- [ ] マイク → `{type:"audio", data}` 送信確認（`audio_chunk` ではないこと）
- [ ] `start_stream` が送信されないことを確認（WS frames をフィルタ）
- [ ] ユーザー `transcription(role:user, is_partial:true)` → input欄にリアルタイム表示
- [ ] ユーザー `transcription(role:user, is_partial:false)` → `handleStreamingSTTComplete` → ack再生 → `sendMessage()` → WS テキスト送信

#### AI音声再生
- [ ] `audio` (PCM 24kHz) → WAV 変換 → 正常再生（`playPcmAudioWithAvatar`）
- [ ] `rest_audio` (MP3) → 正常再生
- [ ] `interrupted` → 即座に再生停止 + 表情リセット

#### リップシンク (concierge)
- [ ] `audio` + `expression` が200ms以内に両方来る → 同時再生（音ズレなし）
- [ ] `audio` のみ（`expression` 来ない） → 200ms後に音声のみ再生
- [ ] `interrupted` → 表情が中立にリセット（`clearFrameBuffer` 呼び出し確認）
- [ ] ペンディングデータ（`pendingLiveAudio`, `pendingExpression`）が `null` にリセットされること

#### 再接続
- [ ] `reconnecting` → voiceStatus に「接続中...」表示、`reconnecting` クラス付与
- [ ] `reconnected` → voiceStatus が「停止中」に復帰、`stopped` クラス
