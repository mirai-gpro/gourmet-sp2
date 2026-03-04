# リップシンク調査・修正依頼書

**日付**: 2026-03-04
**対象**: support-base バックエンド
**報告者**: フロントエンド調査チーム
**優先度**: P0（コンシェルジュモードの主要機能が停止中）

---

## 現象

コンシェルジュモードでアバターのリップシンク（口の動き）が完全に動作していません。
アバターは表示されるが、TTS音声再生時に口が一切動きません。

**補足**: 使用中のアバターモデル (`concierge.zip`) はローカル環境で動作確認済みです。
ローカルでは正常にリップシンクが動いていたため、アバターモデル自体に問題はありません。

### コンソールログ（フロントエンド）

```
[Concierge] TTS response has NO expression data (session=sess_8a42ed204b6f)
[LAM External] TTS play - frameBuffer has 0 frames
[LAM Health] state=Idle, jaw=0.000, mouth=0.000, funnel=0.000, smile=0.000, pucker=0.000, buffer=0, ttsActive=true
```

---

## 原因: バックエンド TTS が Expression データを返していない

**エンドポイント**: `POST /api/v2/rest/tts/synthesize`

**期待するレスポンス**（ローカル環境ではこれが返っていた）:
```json
{
  "success": true,
  "audio": "<base64 MP3>",
  "expression": {
    "names": ["jawOpen", "mouthLowerDownLeft", "mouthFunnel", ...],
    "frames": [[0.12, 0.08, 0.05, ...], [0.15, 0.10, 0.06, ...], ...],
    "frame_rate": 30
  }
}
```

**デプロイ環境の実際のレスポンス**:
```json
{
  "success": true,
  "audio": "<base64 MP3>"
}
```

**→ `expression` フィールドが完全に欠落**

**推定原因**:
- `audio2exp` サービス（Audio-to-Expression 変換）がデプロイ環境で未起動 or 未接続
- TTS → audio2exp パイプラインの接続が切れている
- audio2exp サービスのエラーが握りつぶされている（silent fail）
- 環境変数（`AUDIO2EXP_URL` 等）がデプロイ環境で未設定

---

## 確認・修正依頼

### 1. audio2exp サービスの状態確認

- [ ] `audio2exp` サービスは Cloud Run にデプロイされているか？
- [ ] サービスは正常にヘルスチェックを通過しているか？
- [ ] Cloud Run のログにエラーが出ていないか？

### 2. TTS エンドポイントの audio2exp 連携確認

- [ ] `/api/v2/rest/tts/synthesize` 内で audio2exp を呼び出すコードは有効か？
- [ ] 環境変数 `AUDIO2EXP_URL`（または相当する設定）は正しく設定されているか？
- [ ] audio2exp 呼び出し部分の try-catch でエラーが握りつぶされていないか？

### 3. 期待するデータフロー

```
フロントエンド → POST /api/v2/rest/tts/synthesize { text, language_code, voice_name, session_id }
バックエンド   → Google Cloud TTS → MP3 音声生成
バックエンド   → audio2exp サービス → 52ch ARKit ブレンドシェイプ生成（30fps）
バックエンド   → レスポンス: { success: true, audio: "<base64>", expression: { names, frames, frame_rate } }
```

### 4. 検証方法

```bash
curl -X POST https://support-base-32596857330.us-central1.run.app/api/v2/rest/tts/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text": "こんにちは", "language_code": "ja-JP", "voice_name": "ja-JP-Chirp3-HD-Leda", "session_id": "test"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('expression' in d, len(d.get('expression',{}).get('frames',[])), 'frames')"
```

**期待結果**: `True 30 frames`（約1秒のテキストで約30フレーム）
**現在の結果**: `False 0 frames`

---

## フロントエンド側の対応状況

| 項目 | 状態 | 備考 |
|---|---|---|
| TTS Expression 受信・適用 | ✅ 実装済み | `applyExpressionFromTts()` |
| Live API Expression 受信 | ✅ 実装済み | `handleLiveExpression()` |
| LAM Avatar フレームバッファ | ✅ 実装済み | `queueExpressionFrames()` + TTS時刻同期 |
| 30fps→60fps 補間 | ✅ 実装済み | 線形補間 |
| フェードイン/アウト | ✅ 実装済み | 6フレーム200ms |
| FLAME LBS 安全クランプ | ✅ 実装済み | max 0.7 |
| SDK遅延診断ログ | ✅ 追加済み | 3s/8s/15s で expressionBSNum を再チェック |

**→ バックエンドが expression データを返せば、フロントエンドは即座に動作する状態です。**
（ローカル環境で動作確認済み）

---

## 完了チェックリスト

- [ ] audio2exp サービスがデプロイ環境で起動している
- [ ] TTS エンドポイントの環境変数が正しく設定されている
- [ ] curl テストで expression フィールドが返る
- [ ] フロントエンドで `[Concierge] Expression: XX→YY frames` が出力される
- [ ] アバターの口が TTS 音声に同期して動く

---

## 補足: STT品質の低下について

別件として、グルメモードの音声認識品質が低下しています。

**現象**: 「恵比寿のおいしい焼き鳥や」→「エビス の 石 焼き鳥 や」と誤認識
**原因**: Socket.IO STT (Google Cloud STT) が 404 で使用不可のため、Gemini Live API 内蔵 STT のみで認識している

```
[Socket.IO] Not available — using REST STT fallback
```

Gemini の内蔵 STT は日本語認識において Google Cloud STT ほどの精度がない可能性があります。

**対策候補**:
1. Socket.IO STT (Google Cloud STT) エンドポイントを復活させる
2. relay.py の Gemini セッション設定で `speech_config` の `language_code` を明示的に `ja-JP` に設定する
3. Gemini Live API のシステムプロンプトで日本語認識精度を改善する
