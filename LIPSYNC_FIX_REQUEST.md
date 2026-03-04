# リップシンク調査・修正依頼書

**日付**: 2026-03-04（更新）
**対象**: support-base バックエンド（relay.py + REST TTS）
**報告者**: フロントエンド調査チーム
**優先度**: P0（コンシェルジュモードの主要機能が停止中）

---

## 現象

コンシェルジュモードでアバターのリップシンク（口の動き）が完全に動作していません。
アバターは表示されるが、音声再生時に口が一切動きません。

**補足**: アバターモデル (`concierge.zip`) はローカル環境で動作確認済み。
SDK は 3s 後に `expressionBSNum=51` で正常ロードを確認。モデルに問題なし。

---

## 問題は2つ（独立した問題）

### 問題A: REST TTS が Expression データを返していない

**前提**: ローカル環境の REST TTS では expression 付きで正常動作していた。

**エンドポイント**: `POST /api/v2/rest/tts/synthesize`

**ヘルスチェック結果**: `a2e_available: true` ← audio2exp サービス自体は起動中

**にもかかわらず、TTS レスポンスに expression が含まれない**:
```json
// 期待（ローカルではこれが返っていた）
{ "success": true, "audio": "<base64>", "expression": { "names": [...], "frames": [[...], ...], "frame_rate": 30 } }

// 実際（デプロイ環境）
{ "success": true, "audio": "<base64>" }
// → expression フィールドが完全に欠落
```

**推定原因**:
- TTS ハンドラ内で audio2exp 呼び出しがスキップされている（条件分岐 or 環境変数）
- audio2exp 呼び出しが try-catch で握りつぶされている（silent fail）
- audio2exp サービスは生きているが、TTS→audio2exp パイプラインが未接続

---

### 問題B: Live API (relay.py) が expression を audio2exp で生成していない

**前提**: Live API で audio2exp を使うのは今回が初めて。REST API では正常動作。

**フロントエンドの新しいコンソールログ（次回デプロイで確認可能）**:
```
[Live Expr RAW] chunk#1: 789 frames, 52 channels, maxVal=0.0000, jawOpen[24]=0.0000, mouthFunnel[31]=0.0000
[LAM Live] ALL 789 frames have zero mouth values — backend may not be generating expression
```

**現在のログ（修正前）**:
```
[LAM Avatar] Added 789 frames to buffer (total: 789) at 30fps
[LAM TTS-Sync] Frame 0/789: jaw=0.000, mouth=0.000, funnel=0.000, ... time=0ms
```

→ 789フレーム受信（フォーマットはOK）だが **全値ゼロ**。
relay.py が expression メッセージの枠は送っているが、audio2exp で実際の表情を生成していない。

**relay.py で必要な処理**:
```python
# Gemini Live API からの音声チャンクを受信した際:
# 1. PCM 音声データをバッファ
# 2. バッファが一定量溜まったら audio2exp に送信
# 3. audio2exp のレスポンス(names, frames, frame_rate) を WebSocket で送信

# WebSocket メッセージ形式:
# { "type": "expression", "data": { "names": [...52ch...], "frames": [[...], ...], "frame_rate": 30 } }
# ↑ この frames の中身が全ゼロではなく、実際の blendshape 値であること！
```

---

## フロントエンド修正（完了済み）

### 修正1: Live API Expression のリアルタイムクロック同期（今回修正）

**問題**: Live API の音声は `audioIO` (Web Audio API) で再生されるが、expression 再生は `ttsPlayer.currentTime` (HTMLAudioElement) に同期していた。ttsPlayer が進まないため常にフレーム0で停止。

**修正**: `queueLiveExpressionFrames()` を追加。`performance.now()` ベースでフレーム進行。

### 修正2: 診断ログ追加（今回修正）

- `[Live Expr RAW]`: バックエンドからの生データ（maxVal, jawOpen, mouthFunnel）
- `[LAM Live]`: 非ゼロフレーム検出ログ
- バックエンドの問題を即座に切り分け可能

### 既存の実装状況

| 項目 | 状態 | 備考 |
|---|---|---|
| REST TTS Expression 受信・適用 | ✅ 実装済み | `applyExpressionFromTts()` |
| Live API Expression 受信 | ✅ 修正済み | `handleLiveExpression()` → `queueLiveExpressionFrames()` |
| Live API リアルタイム同期 | ✅ 新規追加 | `performance.now()` ベース |
| 30fps→60fps 補間（REST TTS） | ✅ 実装済み | 線形補間 |
| フェードイン/アウト | ✅ 実装済み | 6フレーム200ms |
| FLAME LBS 安全クランプ | ✅ 実装済み | max 0.7 |
| SDK遅延診断ログ | ✅ 追加済み | 3s/8s/15s で expressionBSNum 確認 |
| Barge-in 時の Live Stream 停止 | ✅ 追加済み | `stopLiveStream()` |

---

## バックエンド修正依頼

### 修正A: REST TTS の audio2exp 接続確認

1. `/api/v2/rest/tts/synthesize` 内で audio2exp 呼び出しが有効か確認
2. try-catch で silent fail していないかログを確認
3. 環境変数 `AUDIO2EXP_URL` が正しく設定されているか確認

**検証**:
```bash
curl -s -X POST https://support-base-32596857330.us-central1.run.app/api/v2/rest/tts/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text":"こんにちは","language_code":"ja-JP","voice_name":"ja-JP-Chirp3-HD-Leda","session_id":"test"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('has expression:', 'expression' in d)"
```
期待: `has expression: True`

### 修正B: relay.py に Live API 用 audio2exp 連携を追加

Gemini Live API の音声チャンクを audio2exp に送信し、expression データを生成して WebSocket で返す。

**注意**: 現在 relay.py は expression メッセージの「枠」は送信しているが中身がゼロ。audio2exp の実呼出しが必要。

---

## 完了チェックリスト

### REST TTS
- [ ] curl テストで `expression` フィールドが返る（frames の中身が非ゼロ）
- [ ] フロントエンドで `[Concierge] Expression: XX→YY frames` が出力される
- [ ] 初回挨拶で口が動く

### Live API
- [ ] `[Live Expr RAW]` ログで `maxVal > 0` を確認
- [ ] `[LAM Live]` ログで `non-zero mouth values` を確認
- [ ] `[LAM Live-Sync]` ログで `jaw > 0` を確認
- [ ] 会話中に口が動く

---

## 補足: STT品質の低下について

別件として、グルメモードの音声認識品質が低下しています。

**現象**: 「恵比寿のおいしい焼き鳥や」→「エビス の 石 焼き鳥 や」と誤認識
**原因**: Socket.IO STT (Google Cloud STT) が 404 で使用不可

**対策候補**:
1. Socket.IO STT (Google Cloud STT) エンドポイントを復活させる
2. relay.py で `speech_config` の `language_code` を明示的に `ja-JP` に設定する
