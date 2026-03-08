# audio-manager.ts LiveAPI対応 変更仕様書

> **ベース**: `c81d62f` の audio-manager.ts（REST API版 = オリジナル）
> **参照設計書**:
>   - gemini-live-api-audio-architecture.md
>   - audio-streaming-fix-plan.md
>   - audio-streaming-code-review.md

---

## 0. 方針

オリジナルの audio-manager.ts を**ベース**として、LiveAPI に必要な変更**だけ**を加える。
オリジナルが既に持っている良い設計（シングルトン、canSendAudio フラグ、MediaStream 再利用）は**そのまま活かす**。

---

## 1. オリジナルが既に持っている良い設計（維持）

| 設計 | オリジナルの該当コード | 維持理由 |
|------|----------------------|---------|
| AudioContext シングルトン（iOS） | `globalAudioContext` を再利用 | 設計書 §1.1 準拠 |
| MediaStream 再利用（iOS） | `needNewStream` チェック（track が live なら再利用） | 設計書 §1.1 準拠。getUserMedia 遅延回避 |
| canSendAudio フラグ | `canSendAudio` + `audioBuffer` | 設計書 §1.2「フラグ方式」そのもの |
| バッファリング→一括送信 | audioBuffer に蓄積 → stream_ready 後に flush | 音声冒頭の欠落防止 |
| getUserMediaSafe | レガシーブラウザフォールバック | 堅牢性 |
| unlockAudioParams | iOS Audio Session アンロック | iOS 必須 |
| fullResetAudioResources | セッション終了時の完全解放 | 設計書 §3.1 準拠 |
| レガシー録音（startLegacyRecording） | MediaRecorder + クライアント VAD | WS 不通時のフォールバック |

---

## 2. 変更一覧

### 2.1 トランスポート変更: Socket.IO → コールバック

**理由**: LiveAPI では Socket.IO の `socket.emit('audio_chunk')` ではなく、
WebSocket 経由で `liveWs.sendAudio(base64)` を呼ぶ。
core-controller.ts 側で既にコールバックとして渡す設計になっている。

**変更内容**:

```
【旧】startStreaming(socket, languageCode, onStopCallback, onSpeechStart?)
  - socket.emit('audio_chunk', { chunk, sample_rate })

【新】startStreaming(onAudioChunk: (base64: string) => void, onStopCallback, onSpeechStart?)
  - onAudioChunk(base64)
```

- 第1引数: `socket: any` → `onAudioChunk: (base64: string) => void`
- 第2引数: `languageCode: string` → **削除**（LiveAPI では不要。セッション開始時に設定済み）
- `socket.emit(...)` → `onAudioChunk(base64)` に置換
- `socket.connected` チェック → 削除（コールバック側で制御）

### 2.2 サーバーハンドシェイク削除

**理由**: REST API では `start_stream` → `stream_ready` のハンドシェイクが必要だった。
LiveAPI では WebSocket 接続が確立済みなら即座に音声送信可能。

**変更内容**:

```
【削除】
  socket.emit('stop_stream')
  await sleep(100)
  socket.emit('start_stream', { language_code, sample_rate })
  await streamReadyPromise  （最大500-700ms待機）
  await sleep(200)  // バッファ蓄積待ち
```

- ハンドシェイク部分を**全て削除**
- 代わりに: AudioWorklet 接続完了 → `canSendAudio = true` → バッファ flush → 送信開始
- ハンドシェイク待機が消えることで、初回の遅延が 500-900ms 短縮される

### 2.3 クライアント側 VAD 削除（startStreaming から）

**理由**: 設計書 §1.3「ターン検知は Gemini サーバー側 VAD に委任」。
クライアント VAD の 3.5 秒閾値が Gemini の判断と競合する。

**変更内容**:

- `startStreaming_Default` 内の VAD 関連コードを**削除**:
  - `analyser` 作成・接続
  - `vadCheckInterval` の setInterval
  - `silenceTimer` による自動停止
  - `hasSpoken` / `consecutiveSilenceCount` の管理
- `stopVAD_Default()` → startStreaming からは呼ばれなくなる
- **注意**: `startLegacyRecording` 内の VAD は**維持**（REST API フォールバック時に必要）
- `onSpeechStart` コールバック → 引数としては残す（UI 更新に使用）が、VAD からの呼び出しは削除

### 2.4 PC 版もシングルトンパターンに統一

**理由**: オリジナルの iOS 版は `globalAudioContext` と `mediaStream` を再利用していたが、
PC 版（`startStreaming_Default`）は毎回破棄・再作成していた。
設計書 §1.1「AudioContext / MediaStream / AudioWorkletNode はセッション全体で1つ」。

**変更内容**:

- PC 版でも `audioContext`（既存プロパティ）をシングルトンとして再利用
- PC 版でも `mediaStream` を再利用（iOS 版の `needNewStream` パターンを適用）
- PC 版でも `audioWorkletNode` を再利用（addModule は1回のみ）
- `stopStreaming` → `canSendAudio = false` のみ。ノード破棄しない
- `isModuleRegistered` フラグを追加（addModule の重複呼び出し防止）

```
【旧】stopStreaming_Default()
  - stopVAD
  - workletNode.disconnect() → null
  - mediaStream.stop() → null
  - audioContext.close() → null

【新】stopStreaming()
  - canSendAudio = false
  - audioBuffer = []
  - recordingTimer クリア
  （AudioContext, MediaStream, WorkletNode はそのまま維持）
```

### 2.5 iOS / PC 分岐の統一

**理由**: オリジナルは iOS と PC で別メソッド（`startStreaming_iOS` / `startStreaming_Default`）だったが、
シングルトン化すると両者のロジックはほぼ同一になる。

**変更内容**:

- `startStreaming_iOS` / `startStreaming_Default` → **1つの `startStreaming` に統合**
- 差異は定数のみ:
  - バッファサイズ: iOS=8192, PC=3200
  - AudioWorklet プロセッサ名: iOS=ユニーク名（Safari制約）, PC=固定名
  - フラッシュ間隔: iOS=500ms, PC=100ms
- `stopStreaming_iOS` / `stopStreaming_Default` → **1つの `stopStreaming` に統合**

### 2.6 base64 エンコードの統一

**理由**: オリジナルの PC 版は `FileReader.readAsDataURL` → `split(',')[1]` で base64 変換していた。
iOS 版は `fastArrayBufferToBase64` を使用。非同期の FileReader は遅延の原因。

**変更内容**:

- PC 版も `fastArrayBufferToBase64` を使用（iOS 版と統一）
- FileReader 経由の変換を**削除**
- `fastArrayBufferToBase64` の境界チェックバグ修正:
  `Number.isNaN(c2)` → `c2 === undefined`（undefined は NaN ではないため）

### 2.7 AI 音声再生機能の追加（新規）

**理由**: 設計書 §1.4「iOS 受話口問題の解消」+ §4.1「音声再生パスの統一」。
現行はstub（空メソッド）。HTMLAudioElement ではなく Web Audio API で再生する必要がある。

**変更内容**:

新規プロパティ:
```typescript
private scheduledSources: AudioBufferSourceNode[] = [];
private nextPlayTime: number = 0;
private _isPlaying: boolean = false;
private playbackGeneration: number = 0;
private readonly MAX_SCHEDULE_AHEAD = 0.5; // 秒
```

新規メソッド:
```
playPcmAudio(base64Data: string, sampleRate?: number): Promise<void>
  - キュー方式ギャップレス再生（設計書 Phase 1）
  - base64 → Int16 → Float32 → AudioBuffer → AudioBufferSourceNode.start(nextPlayTime)
  - 先読み制限: nextPlayTime - currentTime > MAX_SCHEDULE_AHEAD なら待機
  - scheduledSources に追加、onended で除去 + disconnect
  - stopPlayback() は呼ばない（チャンク途切れ防止）

playMp3Audio(base64Data: string): Promise<void>
  - 単発再生（ack 音声、GCP TTS 等）
  - base64 → ArrayBuffer → decodeAudioData → AudioBufferSourceNode.start()
  - 再生前に stopAll() で既存再生を停止

stopAll(): void
  - playbackGeneration++
  - scheduledSources の全要素: onended=null → stop() → disconnect()
  - scheduledSources = []
  - nextPlayTime = 0
  - _isPlaying = false

get isPlaying(): boolean
  - return this._isPlaying
```

### 2.8 resumeAudioContext の追加（新規）

**理由**: iOS Safari はバックグラウンド→復帰時に AudioContext が suspended/interrupted になる。
core-controller.ts の visibilitychange から呼べる public メソッドが必要。

**変更内容**:

```
public async resumeAudioContext(): Promise<void>
  - ctx.resume() を試行
  - 失敗時: AudioContext を close → 再生成
  - 依存リセット: audioWorkletNode = null, sourceNode = null, isModuleRegistered = false
  - nextPlayTime = 0, scheduledSources = []
```

---

## 3. 変更しないもの

| コード | 理由 |
|--------|------|
| `startLegacyRecording` | REST API フォールバック。変更不要 |
| `unlockAudioParams` | iOS 対策。そのまま使える |
| `fullResetAudioResources` | セッション終了用。シングルトン解放に適合 |
| `getUserMediaSafe` | レガシーブラウザ対応。そのまま使える |
| レガシー録音の VAD | REST API 時のみ使用。LiveAPI とは無関係 |

---

## 4. Public API 変更まとめ

```typescript
// 【変更】シグネチャ変更
startStreaming(onAudioChunk: (base64: string) => void, onStopCallback: () => void, onSpeechStart?: () => void): Promise<void>

// 【変更】内部実装変更（canSendAudio=false のみ）。シグネチャ同じ
stopStreaming(): void

// 【維持】変更なし
startLegacyRecording(onStopCallback: (audioBlob: Blob) => void, onSpeechStart?: () => void): Promise<void>
unlockAudioParams(elementToUnlock: HTMLAudioElement): void
fullResetAudioResources(): void

// 【新規】AI 音声再生
playPcmAudio(base64Data: string, sampleRate?: number): Promise<void>
playMp3Audio(base64Data: string): Promise<void>
stopAll(): void
get isPlaying(): boolean

// 【新規】iOS バックグラウンド復帰
resumeAudioContext(): Promise<void>

// 【削除】stub → 実装で置換
playTTS(): void  → playPcmAudio / playMp3Audio に統合
stopTTS(): void  → stopAll に統合
```

---

## 5. core-controller.ts 側の変更（参考）

audio-manager.ts の API 変更に伴い、core-controller.ts で必要な変更:

| 箇所 | 変更 |
|------|------|
| `toggleRecording` 内の `startStreaming` 呼び出し | 引数変更に追従（languageCode 削除。第1引数がコールバック）。**現行の呼び出しパターンとほぼ同じ** |
| `playPcmAudio` (L800付近) | `ttsPlayer.src = data:audio → audioManager.playPcmAudio(base64)` |
| `speakTextGCP` の TTS 再生 | `ttsPlayer.play() → audioManager.playMp3Audio(base64)` |
| ack 音声再生 | `ttsPlayer.src + play() → audioManager.playMp3Audio(base64)` |
| `stopCurrentAudio` | `ttsPlayer.pause() → audioManager.stopAll()` |
| `!ttsPlayer.paused` チェック | `audioManager.isPlaying` |
| `visibilitychange` ハンドラ | `audioManager.resumeAudioContext()` 追加 |

---

## 6. 初回遅延の改善見込み

| 操作 | 現行 LiveAPI 版 | 本仕様適用後 |
|------|----------------|-------------|
| マイク開始（初回） | ~1-3秒（Context + getUserMedia + addModule） | ~1-3秒（同じ。初回は不可避） |
| マイク開始（2回目以降） | ~1-3秒（**毎回同じ**） | **~10ms**（canSendAudio = true のみ） |
| マイク停止 | ~100ms（disconnect + close） | **~1ms**（canSendAudio = false のみ） |

---

## 7. 実装順序

1. オリジナル `c81d62f` の audio-manager.ts をベースにコピー
2. §2.1 トランスポート変更（socket → callback）
3. §2.2 ハンドシェイク削除
4. §2.3 VAD 削除（startStreaming から）
5. §2.4 + §2.5 シングルトン統一（iOS/PC 統合）
6. §2.6 base64 統一
7. §2.7 AI 音声再生追加
8. §2.8 resumeAudioContext 追加
9. core-controller.ts 側の変更
