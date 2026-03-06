# 仕様変更書②: LAMAvatar 3Dアバター統合パッチ

## 基準ソース
- 変更前: [mirai-gpro/gourmet-sp](https://github.com/mirai-gpro/gourmet-sp)（①オリジナル）
- 変更後: [LAM_gpro/gourmet-sp](https://github.com/mirai-gpro/LAM_gpro/tree/claude/fix-modelscope-wheels-mpGPD/gourmet-sp)（②アバターパッチ）

---

## 変更目的
コンシェルジュページの2D静止画アバターを、Gaussian Splatting ベースの3Dアバター（LAMAvatar）に置き換え、TTS音声と同期したリップシンク（表情アニメーション）を実現する。

---

## 変更対象ファイル一覧

| ファイル | 変更種別 |
|---|---|
| `src/components/LAMAvatar.astro` | **新規追加** |
| `src/components/Concierge.astro` | 修正 |
| `src/scripts/chat/concierge-controller.ts` | 修正 |
| `src/pages/concierge.astro` | 修正 |
| `src/scripts/chat/core-controller.ts` | 変更なし |
| `src/scripts/chat/audio-manager.ts` | 変更なし |

---

## 1. 新規ファイル: `LAMAvatar.astro`

### 概要
Gaussian Splatting レンダラーを使用した3Dアバターコンポーネント。

### Props
| Prop | 型 | デフォルト | 説明 |
|---|---|---|---|
| `avatarPath` | string | `/avatar/concierge.zip` | 3Dアバターモデルのパス |
| `width` | string | `100%` | キャンバス幅 |
| `height` | string | `100%` | キャンバス高さ |
| `wsUrl` | string | `''` | WebSocket URL（リアルタイム表情用、未使用） |
| `autoConnect` | boolean | `false` | WebSocket自動接続（未使用） |

### 主要クラス: `LAMAvatarController`

#### プロパティ
- `frameBuffer: ExpressionData[]` — 表情フレームバッファ
- `frameRate: number` — 表情フレームレート（デフォルト30fps）
- `ttsPlayer: HTMLAudioElement | null` — 外部TTSプレーヤー参照
- `state: 'Idle' | 'Listening' | 'Thinking' | 'Responding'`

#### メソッド

| メソッド | 説明 |
|---|---|
| `init()` | レンダラー読み込み、ヘルスチェック開始 |
| `loadRenderer()` | gaussian-splat-renderer-for-lam インポート、カメラ設定 |
| `setExternalTtsPlayer(player)` | 外部Audio要素をリンク、play/pause/endedイベント監視 |
| `queueExpressionFrames(frames, frameRate)` | 表情フレームをバッファに追加 |
| `clearFrameBuffer()` | バッファクリア、同期タイミングリセット |
| `getExpressionData()` | レンダラーから毎フレーム呼ばれる（~60fps）、ttsPlayer.currentTimeで同期 |

#### カメラ設定
```
position: (0, 1.72, 0.55)
FOV: 38
target.y: 1.66
```

#### グローバル公開
```javascript
window.lamAvatarController = new LAMAvatarController(container);
```

---

## 2. 修正: `Concierge.astro`

### 変更点

| 箇所 | 変更内容 |
|---|---|
| import | `LAMAvatar.astro` を追加 |
| Props | `useLAMAvatar?: boolean`（デフォルト true）、`avatarPath?: string` 追加 |
| HTML | avatar-stage 内を条件分岐: `useLAMAvatar ? <LAMAvatar> : <img>` |
| CSS | `.gourmet-chat-container` 高さ: `max-height: 650px` → `height: calc(100dvh - 40px); max-height: 960px` |
| CSS | `.avatar-stage` 高さ: `140px` → `300px` |
| CSS | `.chat-area` min-height: `0` → `150px` |
| CSS（モバイル） | `.avatar-stage` 高さ: `100px` → `200px` |

---

## 3. 修正: `concierge-controller.ts`

### 3.1 新規プロパティ
```typescript
private pendingAckPromise: Promise<void> | null = null;
```

### 3.2 init() — LAMAvatar リンク追加
```typescript
// LAMAvatar が後から初期化される可能性があるため、即時 + 2秒遅延でリンク
const linkTtsPlayer = () => {
  const lam = (window as any).lamAvatarController;
  if (lam && typeof lam.setExternalTtsPlayer === 'function') {
    lam.setExternalTtsPlayer(this.ttsPlayer);
    return true;
  }
  return false;
};
if (!linkTtsPlayer()) {
  setTimeout(() => linkTtsPlayer(), 2000);
}
```

### 3.3 initializeSession() — TTS に session_id 追加
```
変更前: body: { text, language_code, voice_name }
変更後: body: { text, language_code, voice_name, session_id: this.sessionId }
```
**理由**: バックエンドが session_id に基づいて Expression データを同梱返却するため。

### 3.4 speakTextGCP() — 完全書き換え

#### 変更前（①オリジナル）
```typescript
// 親クラスのTTS処理を実行
await super.speakTextGCP(text, stopPrevious, autoRestartMic, skipAudio);
// アバターアニメーションを停止
this.stopAvatarAnimation();
```

#### 変更後（②アバターパッチ）
1. アバターに `.speaking` クラス追加
2. TTS API 呼び出し（`session_id` 付き）
3. レスポンスの `data.expression` を `applyExpressionFromTts()` で LAMAvatar に投入
4. `ttsPlayer.src` に base64 音声セット
5. `isUserInteracted` に応じて再生 or `showClickPrompt()`
6. 完了時に `stopAvatarAnimation()`

**TTS レスポンス拡張フォーマット:**
```json
{
  "success": true,
  "audio": "base64...",
  "expression": {
    "names": ["jawOpen", "mouthLowerDownLeft", ...],
    "frames": [{ "weights": [0.1, 0.2, ...] }, ...],
    "frame_rate": 30
  }
}
```

### 3.5 新規メソッド: `applyExpressionFromTts()`
- `expression.names` と `expression.frames[].weights` を `{ name: value }` 形式に変換
- `lamController.clearFrameBuffer()` でバッファクリア後に投入
- `lamController.queueExpressionFrames(frames, frame_rate)` で投入

### 3.6 新規メソッド: `stopAvatarAnimation()`
- `.speaking` クラス除去

### 3.7 handleStreamingSTTComplete() — 並行処理改善

#### 変更前（①オリジナル）
```typescript
// async IIFE でack完了を待ってからsendMessage
(async () => {
  if (firstAckPromise) await firstAckPromise;
  this.isFromVoiceInput = true;
  this.sendMessage();
})();
```

#### 変更後（②アバターパッチ）
```typescript
// pendingAckPromiseに保存、sendMessage内でawait（~700ms短縮）
this.pendingAckPromise = new Promise<void>((resolve) => {
  // ...onended + onpause でresolve（デッドロック防止）
});
this.isFromVoiceInput = true;
this.sendMessage(); // ack完了を待たず即実行
```

### 3.8 sendMessage() — pendingAckPromise 同期

#### 追加箇所
1. `unlockAudioParams()` を `pendingAckPromise` が無い時のみ実行
2. ショップ紹介フロー開始前に `pendingAckPromise` をawait + `stopCurrentAudio()`

### 3.9 speakResponseInChunks() — Expression 同梱対応

#### 変更前（①オリジナル）
- TTS結果を `data:audio/mp3;base64,...` URL文字列で返却
- Expression 処理なし

#### 変更後（②アバターパッチ）
- TTS結果を JSON オブジェクトで返却（`fetch().then(r => r.json())`）
- `result.expression` があれば `applyExpressionFromTts()` 呼び出し
- `session_id` を TTS リクエストに追加

---

## 4. 修正: `concierge.astro`（ページ）
- ConciergeComponent に `useLAMAvatar={true}` `avatarPath="/avatar/concierge.zip"` を渡す（デフォルト値使用）

---

## 依存関係

| 依存 | 種別 | 説明 |
|---|---|---|
| `gaussian-splat-renderer-for-lam` | npm パッケージ | 3D Gaussian Splatting レンダラー |
| `/avatar/concierge.zip` | 静的ファイル | 3Dアバターモデルデータ |
| バックエンド TTS API | API変更 | `expression` フィールドの同梱返却が必要 |
