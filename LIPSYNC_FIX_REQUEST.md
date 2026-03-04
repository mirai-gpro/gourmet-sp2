# リップシンク調査・修正依頼書

**日付**: 2026-03-04
**対象**: support-base バックエンド + アバターモデル
**報告者**: フロントエンド調査チーム
**優先度**: P0（コンシェルジュモードの主要機能が停止中）

---

## 現象

コンシェルジュモードでアバターのリップシンク（口の動き）が完全に動作していません。
アバターは表示されるが、TTS音声再生時に口が一切動きません。

### コンソールログ（フロントエンド）

```
[SDK] useFlame = false
[SDK] viewer.useFlame = false
[SDK] expressionBSNum = 0
[SDK] gaussianSplatCount = 20018
[SDK] useFlameModel = false
[SDK] morphTargetDictionary: null (not yet built)
[SDK] bsCount uniform = undefined
[SDK] boneTextureSize = undefinedxundefined
[SDK] flameModelTextureSize = undefinedxundefined

[Concierge] TTS response has NO expression data (session=sess_8a42ed204b6f)
[LAM External] TTS play - frameBuffer has 0 frames
[LAM Health] state=Idle, jaw=0.000, mouth=0.000, funnel=0.000, smile=0.000, pucker=0.000, buffer=0, ttsActive=true
```

---

## 原因分析（2つの独立した問題）

### 問題1: バックエンド TTS が Expression データを返していない

**エンドポイント**: `POST /api/v2/rest/tts/synthesize`

**期待するレスポンス**:
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

**実際のレスポンス**:
```json
{
  "success": true,
  "audio": "<base64 MP3>"
}
```

**→ `expression` フィールドが完全に欠落**

**推定原因**:
- `audio2exp` サービス（Audio-to-Expression 変換）が未起動 or 未デプロイ
- TTS → audio2exp パイプラインが未接続
- audio2exp サービスのエラーが握りつぶされている（silent fail）

**確認事項**:
1. `audio2exp` サービスは Cloud Run にデプロイされているか？
2. TTS エンドポイント内で audio2exp を呼び出すコードは存在するか？
3. audio2exp のログにエラーが出ていないか？
4. 環境変数（`AUDIO2EXP_URL` 等）は正しく設定されているか？

---

### 問題2: アバターモデルに FLAME ブレンドシェイプファイルが欠落

**SDK**: `gaussian-splat-renderer-for-lam` v0.0.9-alpha.1

**SDK の FLAME モデル読込に必要なファイル**:
```
concierge.zip/
├── skin.glb              ← ✅ 存在 (3.6MB)
├── animation.glb         ← ✅ 存在 (2.2MB)
├── offset.ply            ← ✅ 存在 (1.4MB - Gaussian Splat)
├── vertex_order.json     ← ✅ 存在 (209KB)
├── lbs_weight_20k.json   ← ❌ 欠落 (FLAME LBS 重み)
├── flame_params.json     ← ❌ 欠落 (FLAME パラメータ)
└── bone_tree.json        ← ❌ 欠落 (ボーンツリー)
```

**SDK の読込ロジック** (`loadFlameModel`):
```javascript
// SDK内部コード（gaussian-splat-renderer-for-lam.module.js）
const [skinModel, lbs_weight, flame_params, indexes, bone_tree] = yield Promise.all([
    this.unpackAndLoadGlb(pathName + '/skin.glb'),
    this.unpackAndLoadJson(pathName + '/lbs_weight_20k.json'),  // ← 必須
    this.unpackAndLoadJson(pathName + '/flame_params.json'),    // ← 必須
    this.unpackAndLoadJson(pathName + '/vertex_order.json'),
    this.unpackAndLoadJson(pathName + '/bone_tree.json')        // ← 必須
]);
```

**影響**:
- 3ファイル欠落のため、SDK は `useFlame = false` で動作
- `expressionBSNum = 0`（ブレンドシェイプチャンネル数 = 0）
- `morphTargetDictionary = null`（表情辞書未構築）
- → **audio2exp が正常に expression データを返しても、SDK 側で反映不可能**

**全アバターZIPを調査済み** — 全8ファイルが同じ構成（FLAMEファイル欠落）:
| ファイル | サイズ | FLAME対応 |
|---|---|---|
| concierge.zip | 4.1MB | ❌ |
| concierge01.zip | 4.1MB | ❌ |
| concierge03.zip | 3.9MB | ❌ |
| concierge04.zip | 15.6MB | ❌ |
| concierge05.zip | 4.1MB | ❌ |
| concierge_fne.zip | 4.1MB | ❌ |
| concierge_kanna.zip | 4.1MB | ❌ |
| concierge_now.zip | 4.0MB | ❌ |

---

## 修正依頼

### 修正1: audio2exp サービスの有効化（バックエンド）

**目標**: TTS レスポンスに expression データを同梱して返す

1. `audio2exp` サービスのデプロイ状態を確認・起動
2. TTS エンドポイント (`/api/v2/rest/tts/synthesize`) のコードで audio2exp 呼び出しが有効か確認
3. 以下のフローが動作することを確認:
   ```
   フロントエンド → POST /api/v2/rest/tts/synthesize { text, language_code, voice_name }
   バックエンド   → Google Cloud TTS → MP3 音声生成
   バックエンド   → audio2exp サービス → 52ch ARKit ブレンドシェイプ生成（30fps）
   バックエンド   → { success: true, audio: "<base64>", expression: { names, frames, frame_rate } }
   ```

**検証方法**:
```bash
curl -X POST https://support-base-32596857330.us-central1.run.app/api/v2/rest/tts/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text": "こんにちは", "language_code": "ja-JP", "voice_name": "ja-JP-Chirp3-HD-Leda", "session_id": "test"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('expression' in d, len(d.get('expression',{}).get('frames',[])), 'frames')"
```

期待結果: `True 30 frames` (約1秒のテキストで約30フレーム)

---

### 修正2: アバターモデルの FLAME ファイル同梱（モデル生成側）

**目標**: アバターZIPに3つの FLAME ファイルを追加

必要なファイル:
```
lbs_weight_20k.json  — FLAME Linear Blend Skinning の重み行列
flame_params.json    — FLAME モデルのパラメータ（shape, pose）
bone_tree.json       — ボーン階層構造の定義
```

**生成方法**:
- LAM (Live Avatar Model) のトレーニングパイプラインで FLAME ファイルを同時出力する
- OpenAvatarChat の公式サンプルアバターから同構造のファイルを参照
- `skin.glb` と同じキャラクターの FLAME パラメータであることが必須

**FLAME ファイルが追加された場合の期待動作**:
```
[SDK] useFlame = true
[SDK] expressionBSNum = 51 (or 52)
[SDK] morphTargetDictionary: 51 entries
[SDK] bsCount uniform = 51
```

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

**→ バックエンドが expression データを返し、アバターに FLAME ファイルが追加されれば、フロントエンドは即座に動作する状態です。**

---

## 確認チェックリスト

- [ ] audio2exp サービスが Cloud Run にデプロイされている
- [ ] TTS エンドポイントが audio2exp を呼び出している
- [ ] curl テストで expression フィールドが返る
- [ ] アバターZIP に FLAME 3ファイルが同梱されている
- [ ] フロントエンドで `[SDK] expressionBSNum = 51` が出力される
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
2. Gemini Live API のシステムプロンプトで日本語認識を強化する設定を追加
3. relay.py の Gemini セッション設定で `speech_config` の `language_code` を明示的に `ja-JP` に設定する
