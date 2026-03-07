# gourmet-sp2 設計書・仕様書

## 1. ソース構成と変更レイヤー

### レイヤー定義

| レイヤー | ソース | 説明 |
|---|---|---|
| ①オリジナル | [mirai-gpro/gourmet-sp](https://github.com/mirai-gpro/gourmet-sp) | 正常動作するベースライン。REST API v1 |
| ②アバターパッチ | [LAM_gpro/.../gourmet-sp](https://github.com/mirai-gpro/LAM_gpro/tree/claude/fix-modelscope-wheels-mpGPD/gourmet-sp) | LAMAvatar 3Dアバター統合 |
| ③API v2 移行 | gourmet-sp2（本リポジトリ） | バックエンドLive API v2対応に伴うエンドポイントパス変更 |
| ④WebSocket移行 | gourmet-sp2（本リポジトリ） | Socket.IO → ネイティブWebSocket移行 |

### レイヤー別変更一覧

#### ②アバターパッチ（①→②の差分）

**concierge-controller.ts:**
- `pendingAckPromise` 追加（ack再生中のデッドロック防止）
- `linkTtsPlayer()` 追加（LAMAvatar外部TTSプレーヤー連携）
- `speakTextGCP()` 完全書き換え: `super.speakTextGCP()` 呼び出し → 独自実装（session_id付きTTS + Expression同梱処理）
- `applyExpressionFromTts()` 新規追加（Expression→LAMバッファ投入）
- `handleStreamingSTTComplete()` 改善: async IIFE → pendingAckPromise方式
- `sendMessage()` 改善: pendingAckPromise同期ポイント追加
- TTS並行処理: audio URL返却方式 → fetch().then().json()方式 + Expression同梱
- ack TTS に `session_id` 追加

**Concierge.astro:**
- LAMAvatar コンポーネント統合
- `backendUrl` prop 追加
- HTML構造変更（avatar-stage → LAMAvatar）

**core-controller.ts:** 変更なし
**audio-manager.ts:** 変更なし

#### ③API v2 移行（②→③の差分）

**背景:** バックエンドが REST API のみ対応から **Live API（v2）対応に修正**された。これに伴いエンドポイントパス体系が変更された。

**エンドポイントパス変更（全ファイル共通）:**
- `/api/session/start` → `/api/v2/session/start`
- `/api/session/end` → `/api/v2/session/end`
- `/api/chat` → `/api/v2/rest/chat`
- `/api/tts/synthesize` → `/api/v2/rest/tts/synthesize`
- `/api/cancel` → `/api/v2/rest/cancel`

**接続先URL変更:**
- `concierge.astro` / `index.astro`: `backendUrl = 'https://support-base-hhasiuut7q-uc.a.run.app'` 追加
- HTTP fetch: `apiBase=''`（same-origin、Vercel rewrites 経由）。**フロントエンドからバックエンドへ直接REST呼び出しはしない。**
- Socket.IO: `backendUrl` で直接接続（Vercel プロキシ非対応）
- `apiBase`（fetch用）と `backendUrl`（Socket.IO用）は**別々に管理**

**ロジック変更:** `initSocket()` の接続先を `this.apiBase` → `this.container.dataset.backendUrl` に変更

#### ④WebSocket移行（③→④の差分）

**背景:** バックエンド v2 で Socket.IO が廃止され、ネイティブ WebSocket (`/api/v2/live/{session_id}`) に変更された。

**主な変更:**
- Socket.IO (`io()`) → ネイティブ WebSocket (`new WebSocket()`)
- 接続タイミング: コンストラクタ → `initializeSession()` 内（`ws_url` 取得後）
- `sendMessage()`: REST POST → WebSocket テキスト送信
- AI応答・音声・表情・ショップ: REST レスポンス → WebSocket 受信ハンドラ
- 音声ストリーミング: `socket.emit('audio_chunk')` → `ws.send({type:'audio', data:base64})`
- `stream_ready` 待機ロジック削除

**詳細:** → `docs/04-websocket-migration-spec.md` 参照

---

## 2. 現在の問題

### 解決済み
- ③ `apiBase` / `backendUrl` 混同問題 → 分離済み

### 対応中
- ④ Socket.IO → WebSocket 移行（バックエンド v2 で Socket.IO 廃止済み）

---

## 3. 承認待ち

仕様変更書④（`docs/04-websocket-migration-spec.md`）の承認をお願いします。
