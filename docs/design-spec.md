# gourmet-sp2 設計書・仕様書

## 1. ソース構成と変更レイヤー

### レイヤー定義

| レイヤー | ソース | 説明 |
|---|---|---|
| ①オリジナル | [mirai-gpro/gourmet-sp](https://github.com/mirai-gpro/gourmet-sp) | 正常動作するベースライン。REST API v1 |
| ②アバターパッチ | [LAM_gpro/.../gourmet-sp](https://github.com/mirai-gpro/LAM_gpro/tree/claude/fix-modelscope-wheels-mpGPD/gourmet-sp) | LAMAvatar 3Dアバター統合 |
| ③API v2 移行 | gourmet-sp2（本リポジトリ） | バックエンドLive API v2対応に伴うエンドポイントパス変更 |

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
- `concierge.astro`: `backendUrl = 'https://support-base-hhasiuut7q-uc.a.run.app'` 追加
- REST API: Vercel rewrites 経由（same-origin, `apiBaseUrl=''`）
- Socket.IO: Vercel プロキシ非対応のためバックエンドに直接接続（`backendUrl` 使用）

**ロジック変更:** なし（パス文字列の置換と接続先設定変更のみ）

---

## 2. 現在の問題

### 症状
コンシェルジュページ (`/concierge`) でマイクボタン・テキスト入力・全操作が反応しない。

### コンソールログから確認済みの事実
- `[Core] Starting initialization...` → 初期化開始 ✅
- `[Core] Initialization completed` → 初期化完了 ✅
- Socket.IO接続ログ（`connect`イベント）が出ていない
- `[LAM External] TTS play - frameBuffer has 0 frames` → TTS再生試行・失敗
- `ttsActive=true` のまま固着

### 調査が必要な項目
1. Socket.IO接続は確立されているか？（connectイベントのログが空）
2. `isUserInteracted` がfalseのままか？（ブラウザ自動再生ポリシー）
3. `isAISpeaking` / `isProcessing` / `!ttsPlayer.paused` のいずれかが stuck しているか？
4. マイクボタンのクリックイベント自体が発火しているか？

---

## 3. 修正方針（案）

> **注意: 以下は案であり、承認前にコードを変更しない。**

### 修正方針A: 最小限のバグ修正のみ
- 原因を特定し、必要最小限の修正のみ行う
- アーキテクチャ変更は一切しない

### 修正方針B: デバッグログ追加で原因特定を先行
- `toggleRecording()` にconsole.logを追加して状態を可視化
- `initSocket()` のconnectイベントにログ追加
- 原因特定後に修正を決定

---

## 4. ファイル一覧と変更可否

| ファイル | 変更可否 | 理由 |
|---|---|---|
| `core-controller.ts` | ❌ 変更しない | チャットページの動作に影響 |
| `concierge-controller.ts` | ⚠️ バグ修正のみ | ロジック変更・仕様変更は不可 |
| `Concierge.astro` | ⚠️ バグ修正のみ | HTML構造変更は不可 |
| `audio-manager.ts` | ❌ 変更しない | 共通モジュール |

---

## 5. 承認待ち

上記設計に基づき、修正方針の承認をお願いします。
