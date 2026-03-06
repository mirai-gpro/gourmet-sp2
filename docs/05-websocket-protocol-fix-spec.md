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
| B1 | AI応答テキスト (core) | `is_partial` 無視、final のみ表示 | `is_partial:true` → 追記表示、`false` → 確定置換 |
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
| C4 | core `sendMessage()` 内のフォールバック応答生成 (`generateFallbackResponse`, `additionalResponse`) |
| C5 | audio-manager の `start_stream` / `stop_stream` 送信 |

---

## 変更対象ファイル一覧

| ファイル | 変更種別 | 影響範囲 |
|---|---|---|
| `src/scripts/chat/audio-manager.ts` | 修正 | 音声送信プロトコル |
| `src/scripts/chat/core-controller.ts` | 修正 | テキスト送信 + 受信ハンドラ + 停止処理 |
| `src/scripts/chat/concierge-controller.ts` | 大幅修正 | sendMessage REST→WS + 表情同期 |

---

## 1. `audio-manager.ts` 変更詳細

### 1.1 音声チャンク送信フォーマット変更

**対象箇所:** `startStreaming_iOS()` L259-266, `startStreaming_Default()` L430-437

**変更前:**
```typescript
const base64 = fastArrayBufferToBase64(audioChunk.buffer);
ws.send(JSON.stringify({ type: 'audio_chunk', chunk: base64, sample_rate: 16000 }));
```

**変更後:**
```typescript
const base64 = fastArrayBufferToBase64(audioChunk.buffer);
ws.send(JSON.stringify({ type: 'audio', data: base64 }));
```

### 1.2 `start_stream` 送信の削除

**対象箇所:** `startStreaming_iOS()` L273-276, `startStreaming_Default()` L444-447

**変更前:**
```typescript
// ★STEP4: start_stream送信（バックエンドにSTT設定を通知）
if (ws && ws.readyState === WebSocket.OPEN) {
  ws.send(JSON.stringify({ type: 'start_stream', language_code: languageCode, sample_rate: 16000 }));
}
```

**変更後:**
```typescript
// WS接続済み＝音声送信可能（start_stream不要）
```

**理由:** バックエンドは `{type:"audio"}` を受信した時点で自動的にSTT処理を開始する。`start_stream` メッセージは未対応で無視される。

### 1.3 `startStreaming()` の `languageCode` 引数

`start_stream` 削除に伴い、`languageCode` 引数は不要になるが、**後方互換のためシグネチャは変更しない**（呼び出し側の変更を最小化）。内部で使わないだけ。

---

## 2. `core-controller.ts` 変更詳細

### 2.1 テキスト送信フォーマット修正 (A1)

**対象箇所:** `sendMessage()` L716-724

**変更前:**
```typescript
this.wsSend({
  type: 'text',
  session_id: this.sessionId,
  message: message,
  stage: this.currentStage,
  language: this.currentLanguage,
  mode: this.currentMode
});
```

**変更後:**
```typescript
this.wsSend({ type: 'text', data: message });
```

**理由:** バックエンドは `session_id` を WS URL から取得済み。`stage` / `language` / `mode` もセッション開始時に設定済み。`data` フィールドにテキストを格納するのがプロトコル仕様。

### 2.2 `stopStreamingSTT()` から `stop_stream` 送信を削除 (A5)

**対象箇所:** `stopStreamingSTT()` L556-563

**変更前:**
```typescript
protected stopStreamingSTT() {
  this.audioManager.stopStreaming();
  this.wsSend({ type: 'stop_stream' });
  this.isRecording = false;
  // ...UI更新
}
```

**変更後:**
```typescript
protected stopStreamingSTT() {
  this.audioManager.stopStreaming();
  // stop_stream 不要: 音声チャンク送信を止めればバックエンドは自動的にSTT完了を検知
  this.isRecording = false;
  // ...UI更新
}
```

### 2.3 AI応答テキスト: partial 表示対応 (B1)

**対象箇所:** `handleWsMessage()` L278-284

**変更前:**
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

**変更後:**
```typescript
} else if (msg.role === 'ai') {
  this.hideWaitOverlay();
  if (msg.is_partial) {
    // ストリーミング表示: 部分テキストを追記
    this.updateStreamingMessage('assistant', msg.text);
  } else {
    // 確定: バッファクリア → 確定テキストに置換
    this.finalizeStreamingMessage('assistant', msg.text);
    this.currentAISpeech = msg.text;
    this.resetInputState();
  }
}
```

**新規メソッド追加:**
```typescript
// ストリーミング中のメッセージを更新（末尾の吹き出しに追記）
protected updateStreamingMessage(role: string, partialText: string) {
  const messages = this.els.chatMessages.querySelectorAll(`.message.${role}`);
  const lastMsg = messages[messages.length - 1];
  if (lastMsg && lastMsg.classList.contains('streaming')) {
    // 既存のストリーミング吹き出しにテキスト追記
    const content = lastMsg.querySelector('.message-content');
    if (content) content.textContent += partialText;
  } else {
    // 新しいストリーミング吹き出しを作成
    this.addMessage(role, partialText);
    const newMessages = this.els.chatMessages.querySelectorAll(`.message.${role}`);
    const newMsg = newMessages[newMessages.length - 1];
    if (newMsg) newMsg.classList.add('streaming');
  }
}

// ストリーミング完了 → 確定テキストに置換
protected finalizeStreamingMessage(role: string, finalText: string) {
  const messages = this.els.chatMessages.querySelectorAll(`.message.${role}`);
  const lastMsg = messages[messages.length - 1];
  if (lastMsg && lastMsg.classList.contains('streaming')) {
    const content = lastMsg.querySelector('.message-content');
    if (content) content.textContent = finalText;
    lastMsg.classList.remove('streaming');
  } else {
    this.addMessage(role, finalText);
  }
}
```

**注意:** `updateStreamingMessage` / `finalizeStreamingMessage` の実装は既存の `addMessage()` の DOM 構造に合わせて調整が必要。上記は方針のみ。

### 2.4 `reconnecting` / `reconnected` の UI 表示 (B6)

**対象箇所:** `handleWsMessage()` L346-351

**変更前:**
```typescript
case 'reconnecting':
  console.log('[WS] Reconnecting:', msg.reason);
  break;
case 'reconnected':
  console.log('[WS] Reconnected, session count:', msg.session_count);
  break;
```

**変更後:**
```typescript
case 'reconnecting':
  console.log('[WS] Reconnecting:', msg.reason);
  this.showReconnectingUI(msg.reason);
  break;
case 'reconnected':
  console.log('[WS] Reconnected, session count:', msg.session_count);
  this.hideReconnectingUI();
  break;
```

**新規メソッド:**
```typescript
protected showReconnectingUI(reason: string) {
  // 既存の waitOverlay を流用、またはステータス表示
  this.els.voiceStatus.innerHTML = this.t('reconnecting') || '接続中...';
  this.els.voiceStatus.className = 'voice-status reconnecting';
}

protected hideReconnectingUI() {
  this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
  this.els.voiceStatus.className = 'voice-status stopped';
}
```

---

## 3. `concierge-controller.ts` 変更詳細

### 3.1 `sendMessage()` の REST → WS 移行 (A2, B2, B3, B4)

**現在の状態:** L487-751 の `sendMessage()` は REST POST `/api/v2/rest/chat` を呼び出し、レスポンスから `data.response`, `data.shops` を取得し、REST TTS で音声再生している。**約260行。**

**変更後:**

```typescript
protected async sendMessage() {
  let firstAckPromise: Promise<void> | null = null;
  if (!this.pendingAckPromise) {
    this.unlockAudioParams();
  }
  const message = this.els.userInput.value.trim();
  if (!message || this.isProcessing) return;

  const isTextInput = !this.isFromVoiceInput;

  this.isProcessing = true;
  this.els.sendBtn.disabled = true;
  this.els.micBtn.disabled = true;
  this.els.userInput.disabled = true;

  if (!this.isFromVoiceInput) {
    this.addMessage('user', message);
    const textLength = message.trim().replace(/\s+/g, '').length;
    if (textLength < 2) {
      const msg = this.t('shortMsgWarning');
      this.addMessage('assistant', msg);
      if (this.isTTSEnabled && this.isUserInteracted) await this.speakTextGCP(msg, true);
      this.resetInputState();
      return;
    }

    this.els.userInput.value = '';

    const ackText = this.t('ackYes');
    this.currentAISpeech = ackText;
    this.addMessage('assistant', ackText);

    if (this.isTTSEnabled && !isTextInput) {
      try {
        const preGeneratedAudio = this.preGeneratedAcks.get(ackText);
        if (preGeneratedAudio && this.isUserInteracted) {
          firstAckPromise = new Promise<void>((resolve) => {
            this.lastAISpeech = this.normalizeText(ackText);
            this.ttsPlayer.src = `data:audio/mp3;base64,${preGeneratedAudio}`;
            this.ttsPlayer.onended = () => resolve();
            this.ttsPlayer.play().catch(_e => resolve());
          });
        } else {
          firstAckPromise = this.speakTextGCP(ackText, false);
        }
      } catch (_e) {}
    }
    if (firstAckPromise) await firstAckPromise;
  }

  this.isFromVoiceInput = false;

  if (this.waitOverlayTimer) clearTimeout(this.waitOverlayTimer);
  this.waitOverlayTimer = window.setTimeout(() => { this.showWaitOverlay(); }, 6500);

  // ★ WebSocket経由でテキスト送信（REST不要）
  this.wsSend({ type: 'text', data: message });
  this.els.userInput.blur();
  // レスポンスは handleWsMessage() で処理
}
```

**削除されるもの:**
- REST `/api/v2/rest/chat` の fetch 呼び出し
- REST レスポンス解析 (`data.response`, `data.shops`)
- REST TTS 並列リクエスト (`/api/v2/rest/tts/synthesize` x 2)
- ショップ紹介音声の手動組み立て
- `speakResponseInChunks()` の呼び出し

### 3.2 `handleWsMessage()` — 応答処理の強化

concierge の `handleWsMessage()` は既に `audio`, `expression`, `rest_audio`, `interrupted` を処理している。追加で必要な変更:

**変更前（`default` で親に委譲）:**
```typescript
default:
  // transcription, shop_cards, error, reconnecting, reconnected は親クラスで処理
  super.handleWsMessage(msg);
  break;
```

これは正しい。親クラスの `handleWsMessage()` が `transcription`, `shop_cards`, `error`, `reconnecting`, `reconnected` を処理する。

**ただし `shop_cards` 受信時のアバター制御を追加:**
```typescript
case 'shop_cards':
  // 親クラスでカード表示 + テキスト表示
  super.handleWsMessage(msg);
  // アバター側: 店舗紹介モードに遷移
  if (this.els.avatarContainer) this.els.avatarContainer.classList.add('presenting');
  break;
```

### 3.3 `speakTextGCP()` の役割変更

**変更前:** AI応答音声の主要な再生手段（REST TTS呼び出し）

**変更後:** **ack音声・イントロTTS専用**。AI応答音声は WS `audio` メッセージで受信・再生される。

`speakTextGCP()` 自体は削除しない。以下の用途で継続使用:
- `ackYes` の音声再生（プリ生成されていない場合のフォールバック）
- `shortMsgWarning` の音声再生
- `ttsIntro` の音声再生

ただし、`sendMessage()` 内から `speakResponseInChunks()` 等の REST TTS 呼び出しは削除。

---

## 4. リップシンク（A2E 表情同期）実装

### 4.1 概要

バックエンドは AI 音声生成時に A2E サービスで表情データ（ARKit 52 ブレンドシェイプ × 30fps フレーム列）を生成し、`expression` メッセージとして WS 送信する。`audio` と `expression` は同じ音声から生成されており、同時再生すれば自動同期する。

### 4.2 メッセージフォーマット

```json
{
  "type": "expression",
  "data": {
    "names": ["eyeBlinkLeft", "eyeBlinkRight", ..., "jawOpen", ...],  // 52個
    "frames": [[0.0, 0.0, ..., 0.15, ...], ...],  // N×52 の2次元配列
    "frame_rate": 30,
    "chunk_index": 0,
    "is_final": true
  }
}
```

### 4.3 同期再生アルゴリズム (B5)

**現在の実装（NG）:** `expression` 受信 → 即座に `applyExpressionFromTts()` で適用

**変更後:**

```
1. audio 受信 → pendingAudio に格納（まだ再生しない）
2. expression 受信 → pendingExpression に格納
3. 両方揃ったら → 音声再生 & 表情再生を同時開始
4. audio のみ200ms待ってもexpression来ない → 音声のみ再生開始
5. expression が後から来たら → 音声の経過時間に合わせてフレームを途中から再生
```

**concierge-controller に追加するプロパティ:**

```typescript
private pendingLiveAudio: string | null = null;      // PCM 24kHz base64
private pendingExpression: ExpressionData | null = null;
private expressionWaitTimer: ReturnType<typeof setTimeout> | null = null;
```

**`handleWsMessage()` の `audio` / `expression` ケース変更:**

```typescript
case 'audio':
  this.isAISpeaking = true;
  if (this.els.avatarContainer) this.els.avatarContainer.classList.add('speaking');
  this.pendingLiveAudio = msg.data;
  this._tryStartSyncedPlayback();
  // expression が来ない場合のフォールバック（200ms）
  this.expressionWaitTimer = setTimeout(() => {
    if (this.pendingLiveAudio) {
      this.playPcmAudioWithAvatar(this.pendingLiveAudio);
      this.pendingLiveAudio = null;
    }
  }, 200);
  break;

case 'expression':
  this.pendingExpression = msg.data;
  if (this.expressionWaitTimer) {
    clearTimeout(this.expressionWaitTimer);
    this.expressionWaitTimer = null;
  }
  this._tryStartSyncedPlayback();
  break;
```

**同期再生メソッド:**

```typescript
private _tryStartSyncedPlayback() {
  if (this.pendingLiveAudio && this.pendingExpression) {
    // 表情フレームをアバターにキューイング
    this.applyExpressionFromTts(this.pendingExpression);
    // 音声再生開始（表情は音声と同時にアニメーション開始）
    this.playPcmAudioWithAvatar(this.pendingLiveAudio);
    this.pendingLiveAudio = null;
    this.pendingExpression = null;
  }
}
```

### 4.4 `interrupted` 時の表情リセット

**変更後:**

```typescript
case 'interrupted':
  this.stopCurrentAudio();
  this.isAISpeaking = false;
  this.stopAvatarAnimation();
  // 表情を中立にリセット
  if (window.lamAvatarController) {
    window.lamAvatarController.clearFrameBuffer();
  }
  // ペンディングデータもクリア
  this.pendingLiveAudio = null;
  this.pendingExpression = null;
  if (this.expressionWaitTimer) {
    clearTimeout(this.expressionWaitTimer);
    this.expressionWaitTimer = null;
  }
  break;
```

### 4.5 `rest_audio` と表情の関係

仕様書より:
> `rest_audio` は `expression` メッセージを伴いません（MPF音声のため）。

`rest_audio` 再生中はアバターを idle 状態にする（現在の実装で問題なし）。

---

## 5. core-controller `sendMessage()` の整理 (C4)

### 5.1 フォールバック応答の削除

**対象箇所:** core-controller `sendMessage()` L698-708

**変更前:**
```typescript
const cleanText = this.removeFillers(message);
const fallbackResponse = this.generateFallbackResponse(cleanText);

if (this.isTTSEnabled && this.isUserInteracted) await this.speakTextGCP(fallbackResponse, false, false, isTextInput);
this.addMessage('assistant', fallbackResponse);

setTimeout(async () => {
  const additionalResponse = this.t('additionalResponse');
  if (this.isTTSEnabled && this.isUserInteracted) await this.speakTextGCP(additionalResponse, false, false, isTextInput);
  this.addMessage('assistant', additionalResponse);
}, 3000);
```

**変更後:** 削除。

**理由:** テキスト入力時もバックエンドに WS 送信するため、フォールバック応答は不要。バックエンドの `transcription(role:ai)` で正式な応答が返ってくる。

---

## 6. 変更の優先順位

| 優先度 | 変更 | 影響 |
|--------|------|------|
| **P0 (必須)** | A1: core テキスト送信 `{type:"text", data}` | テキストチャットが動かない |
| **P0 (必須)** | A3: 音声チャンク `{type:"audio", data}` | 音声認識が動かない |
| **P0 (必須)** | A4: `start_stream` 削除 | 不明なメッセージでエラーの可能性 |
| **P0 (必須)** | A2: concierge sendMessage WS 化 | concierge テキストチャットが動かない |
| **P1 (重要)** | A5: `stop_stream` 削除 | 不明なメッセージ送信 |
| **P1 (重要)** | B5: audio + expression 同期再生 | リップシンクの音ズレ |
| **P1 (重要)** | C4: フォールバック応答削除 | 二重応答表示 |
| **P2 (改善)** | B1: AI partial テキスト表示 | ストリーミング UX |
| **P2 (改善)** | B6: reconnecting UI | 再接続時の UX |
| **P3 (将来)** | C3: speakResponseInChunks 削除 | コード整理 |

---

## 7. 音声フォーマット整理

| 方向 | 形式 | サンプルレート | 用途 |
|------|------|-------------|------|
| **送信** (マイク→サーバー) | PCM 16bit mono base64 | 16kHz | STT用 |
| **受信** `audio` | PCM 16bit mono base64 | 24kHz | AI音声 (Gemini Live) |
| **受信** `rest_audio` | MP3 base64 | — | 店舗紹介TTS |
| **ローカル** ack/intro | MP3 base64 | — | プリ生成済み即答 |

---

## 8. テスト計画

### 8.1 テキストチャット
- [ ] テキスト入力 → WS `{type:"text", data}` 送信確認
- [ ] AI `transcription(role:ai, is_partial:true)` → ストリーミング表示
- [ ] AI `transcription(role:ai, is_partial:false)` → 確定テキスト表示
- [ ] `shop_cards` 受信 → カード表示

### 8.2 音声入力
- [ ] マイク → `{type:"audio", data}` 送信確認（`audio_chunk` ではない）
- [ ] `start_stream` が送信されないことを確認
- [ ] ユーザー `transcription(role:user)` → 文字起こし表示
- [ ] 音声入力完了 → AI応答受信

### 8.3 AI音声再生
- [ ] `audio` (PCM 24kHz) → 正常再生
- [ ] `rest_audio` (MP3) → 正常再生
- [ ] `interrupted` → 即座に再生停止

### 8.4 リップシンク (concierge)
- [ ] `audio` + `expression` → 同時再生（音ズレなし）
- [ ] `expression` のみ来ない → 200ms後に音声のみ再生
- [ ] `interrupted` → 表情が中立にリセット

### 8.5 再接続
- [ ] `reconnecting` → UI表示
- [ ] `reconnected` → UI復帰
