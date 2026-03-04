# バックエンド調査・修正指示書: リップシンク（Expression）

> **日付**: 2026-03-04
> **対象リポジトリ**: support-base
> **依頼元**: gourmet-sp2 フロントエンドチーム
> **優先度**: P0（コンシェルジュモードの主要機能が停止中）

---

## 背景

コンシェルジュモードのアバターリップシンク（口の動き）が完全に停止しています。
フロントエンド側の実装は完了しており、**バックエンドが正しい expression データを返せば即座に動作する状態**です。

- アバターモデル (`concierge.zip`) はローカル環境でリップシンク動作確認済み
- SDK は `expressionBSNum=51`（51チャンネルのブレンドシェイプ）を正常ロード
- ヘルスチェック `a2e_available: true` — audio2exp サービス自体は稼働中

**問題は2つ（独立した問題）**:

| # | 問題 | 経路 | 現象 |
|---|------|------|------|
| A | REST TTS が expression を返さない | `/api/v2/rest/tts/synthesize` | expression フィールドが完全に欠落 |
| B | Live API の expression が全値ゼロ | WebSocket `type: "expression"` | 789フレーム受信するが全チャンネル 0.000 |

---

## 現在の状態（ヘルスチェック結果）

```bash
curl https://support-base-32596857330.us-central1.run.app/api/v2/health
```

```json
{
  "status": "healthy",
  "modes": [{"name": "gourmet", "display_name": "グルメコンシェルジュ"}],
  "a2e_available": true,
  "active_sessions": 0,
  "gemini_api_configured": true
}
```

→ `a2e_available: true` なのに expression が正しく返らない。

---

## 問題A: REST TTS が Expression データを返さない

### 現象

```bash
curl -s -X POST https://support-base-32596857330.us-central1.run.app/api/v2/rest/tts/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text":"こんにちは","language_code":"ja-JP","voice_name":"ja-JP-Chirp3-HD-Leda","session_id":"test"}'
```

**期待するレスポンス**:
```json
{
  "success": true,
  "audio": "<base64 MP3>",
  "expression": {
    "names": ["browDownLeft", "browDownRight", ..., "tongueOut"],
    "frames": [[0.01, 0.02, ..., 0.00], [0.03, 0.05, ..., 0.00], ...],
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

→ **`expression` フィールドが完全に欠落**

### 調査手順

#### Step 1: TTS ハンドラのコード確認

```bash
# rest/router.py の TTS エンドポイントを確認
grep -n -A 30 "def.*tts\|synthesize" support_base/rest/router.py
```

**確認ポイント**:
- `audio2exp` / `a2e` の呼び出しコードが存在するか？
- 存在する場合、条件分岐で無効化されていないか？
- try-catch で例外が握りつぶされていないか？

#### Step 2: audio2exp 呼び出しコードの特定

```bash
# audio2exp 関連コードを検索
grep -rn "audio2exp\|a2e\|expression\|audio_to_exp" support_base/
```

**確認ポイント**:
- audio2exp を呼び出す関数/クラスはどこに定義されているか？
- TTS ハンドラからその関数が呼ばれているか？
- 環境変数（`AUDIO2EXP_URL` 等）が正しく設定されているか？

#### Step 3: 環境変数の確認

```bash
# Cloud Run の環境変数を確認
gcloud run services describe support-base --region=us-central1 --format='yaml(spec.template.spec.containers[0].env)'

# audio2exp 関連の環境変数を確認
gcloud run services describe support-base --region=us-central1 --format='yaml' | grep -i "a2e\|audio2exp\|expression"
```

#### Step 4: Cloud Run ログの確認

```bash
# TTS エンドポイントのログを確認
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="support-base" AND (textPayload=~"tts" OR textPayload=~"a2e" OR textPayload=~"expression" OR textPayload=~"audio2exp")' \
  --limit=30 --format="table(timestamp,textPayload)"
```

#### Step 5: audio2exp サービスへの直接テスト

```bash
# ヘルスチェックで確認された a2e_available=true の接続先を特定
grep -rn "a2e_available\|audio2exp.*health\|a2e.*url" support_base/

# audio2exp サービスに直接リクエストを送ってテスト
# （URLは上記で特定したものを使用）
```

### 想定される原因と修正

#### パターン1: audio2exp 呼び出しがコメントアウト or 条件分岐で無効

```python
# ❌ こうなっていないか？
async def synthesize_tts(request):
    audio = await google_tts(request.text, ...)

    # expression = await audio2exp(audio)  # ← コメントアウト？
    # if USE_A2E:                          # ← フラグで無効？
    #     expression = await audio2exp(audio)

    return {"success": True, "audio": base64_audio}
```

**修正**: audio2exp 呼び出しを有効化する

```python
# ✅ 期待するコード
async def synthesize_tts(request):
    audio_bytes = await google_tts(request.text, ...)

    expression = None
    try:
        expression = await audio2exp_service.process(audio_bytes)
    except Exception as e:
        logger.error(f"[TTS] audio2exp failed: {e}")
        # expression なしでも audio は返す（graceful degradation）

    result = {"success": True, "audio": base64_audio}
    if expression:
        result["expression"] = expression
    return result
```

#### パターン2: try-catch で silent fail

```python
# ❌ エラーが握りつぶされていないか？
try:
    expression = await audio2exp(audio)
except:
    pass  # ← silent fail!
```

**修正**: エラーログを追加

```python
# ✅
try:
    expression = await audio2exp(audio)
except Exception as e:
    logger.error(f"[TTS] audio2exp error: {e}", exc_info=True)
```

#### パターン3: expression を response に含めていない

```python
# ❌ expression を計算しているが response に含めていないパターン
expression = await audio2exp(audio)
return {"success": True, "audio": base64_audio}  # ← expression 未包含!
```

**修正**: response dict に expression を追加

### 検証方法

修正後、以下で確認:

```bash
curl -s -X POST https://support-base-32596857330.us-central1.run.app/api/v2/rest/tts/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text":"こんにちは","language_code":"ja-JP","voice_name":"ja-JP-Chirp3-HD-Leda","session_id":"test"}' \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
has_expr = 'expression' in d
if has_expr:
    e = d['expression']
    print(f'OK: {len(e[\"names\"])} channels, {len(e[\"frames\"])} frames, rate={e[\"frame_rate\"]}')
    # フレーム内の最大値を確認（非ゼロであること）
    max_val = max(max(abs(v) for v in f) for f in e['frames'])
    print(f'Max blendshape value: {max_val:.4f} (should be > 0)')
else:
    print('NG: expression field missing')
    print('Response keys:', list(d.keys()))
"
```

**期待結果**:
```
OK: 52 channels, 30 frames, rate=30
Max blendshape value: 0.4523 (should be > 0)
```

---

## 問題B: Live API (relay.py) の Expression が全値ゼロ

### 現象

relay.py は WebSocket で `type: "expression"` メッセージを送信しているが、
frames 内の全チャンネルが 0.000。

フロントエンドの診断ログ:
```
[LAM Avatar] Added 789 frames to buffer (total: 789) at 30fps
[LAM TTS-Sync] Frame 0/789: jaw=0.000, mouth=0.000, funnel=0.000, smile=0.000, pucker=0.000
```

→ 789フレーム（約26秒分）受信。フォーマットは正しい。しかし**全値ゼロ**。

### 前提

**Live API で audio2exp を使うのは今回が初めて。REST TTS では正常動作していた（ローカル）。**

つまり relay.py に audio2exp 連携がまだ実装されていないか、プレースホルダーとしてゼロを送信している可能性が高い。

### 調査手順

#### Step 1: relay.py の expression 送信コードを確認

```bash
# relay.py で expression 関連のコードを検索
grep -n "expression\|a2e\|audio2exp\|blendshape" support_base/live/relay.py
```

**確認ポイント**:
- `expression` タイプのメッセージをどこで構築・送信しているか？
- そのフレームデータはどこから来ているか？（audio2exp 実呼出し or ダミーデータ）

#### Step 2: Gemini 音声出力の取得方法を確認

```bash
# Gemini からの音声受信部分を確認
grep -n "audio\|server_content\|InlineData\|pcm\|_recv" support_base/live/relay.py
```

**確認ポイント**:
- Gemini Live API からの音声チャンクはどの変数に格納されるか？
- その音声データのフォーマット（PCM 24kHz 16bit mono 等）
- 音声チャンクが WebSocket クライアントに送信される場所

#### Step 3: audio2exp サービスの入力フォーマットを確認

```bash
# audio2exp サービスのインターフェースを確認
grep -rn "class.*Audio2Exp\|def.*process\|def.*predict\|def.*convert" support_base/
```

**確認ポイント**:
- audio2exp が期待する入力フォーマット（PCM? WAV? MP3?）
- audio2exp のレスポンスフォーマット（names, frames, frame_rate の構造）
- バッチ処理 or ストリーミング対応か？

### 実装方針

#### アプローチ1: 音声チャンクをバッファリングして一括処理

```python
class LiveRelay:
    def __init__(self, ...):
        self._audio_buffer = bytearray()  # Gemini 音声バッファ
        self._a2e_task = None

    async def _recv_from_gemini(self):
        """Gemini からの応答を処理"""
        async for response in self.gemini_session:
            sc = response.server_content
            if not sc:
                # tool_call 等
                continue

            for part in sc.parts:
                if part.inline_data:
                    audio_data = part.inline_data.data
                    # 1. クライアントへ音声送信（即座）
                    await self._send_audio(audio_data)
                    # 2. audio2exp 用にバッファリング
                    self._audio_buffer.extend(audio_data)

            if sc.turn_complete:
                # ターン完了時: バッファした音声全体で expression 生成
                await self._process_expression()
                self._audio_buffer = bytearray()

    async def _process_expression(self):
        """バッファした音声から expression を生成して送信"""
        if not self._audio_buffer:
            return
        try:
            result = await self.a2e_service.process(
                audio_data=bytes(self._audio_buffer),
                sample_rate=24000,  # Gemini の出力レート
                format="pcm_s16le"  # PCM 16bit little-endian
            )
            if result and result.get("frames"):
                await self.websocket.send_json({
                    "type": "expression",
                    "data": {
                        "names": result["names"],      # 52ch ARKit 名
                        "frames": result["frames"],    # [[0.1, ...], ...]
                        "frame_rate": result.get("frame_rate", 30)
                    }
                })
                logger.info(
                    f"[LiveRelay] Expression sent: {len(result['frames'])} frames, "
                    f"max_val={max(max(abs(v) for v in f) for f in result['frames']):.3f}"
                )
        except Exception as e:
            logger.error(f"[LiveRelay] audio2exp failed: {e}", exc_info=True)
```

#### アプローチ2: 音声チャンクをストリーミング処理（低遅延）

```python
    async def _recv_from_gemini(self):
        chunk_buffer = bytearray()
        CHUNK_DURATION_MS = 1000  # 1秒分バッファしたら処理

        async for response in self.gemini_session:
            sc = response.server_content
            if not sc:
                continue

            for part in sc.parts:
                if part.inline_data:
                    audio_data = part.inline_data.data
                    await self._send_audio(audio_data)
                    chunk_buffer.extend(audio_data)

                    # 1秒分溜まったら expression 生成
                    bytes_per_sec = 24000 * 2  # 24kHz * 16bit
                    if len(chunk_buffer) >= bytes_per_sec * CHUNK_DURATION_MS / 1000:
                        asyncio.create_task(
                            self._send_expression_chunk(bytes(chunk_buffer))
                        )
                        chunk_buffer = bytearray()

            if sc.turn_complete:
                # 残りのバッファも処理
                if chunk_buffer:
                    await self._send_expression_chunk(bytes(chunk_buffer))
                    chunk_buffer = bytearray()

    async def _send_expression_chunk(self, audio_chunk: bytes):
        try:
            result = await self.a2e_service.process(audio_chunk, sample_rate=24000)
            if result and result.get("frames"):
                await self.websocket.send_json({
                    "type": "expression",
                    "data": result
                })
        except Exception as e:
            logger.error(f"[LiveRelay] a2e chunk error: {e}")
```

### 重要な注意点

1. **Gemini の音声フォーマットを確認すること**
   - 通常は PCM 24kHz 16bit mono だが、`speech_config` によって異なる場合がある
   - audio2exp が期待するフォーマットと一致させる必要がある

2. **audio2exp の入力フォーマットとの整合性**
   - REST TTS では MP3 → audio2exp で動いていた
   - Live API では PCM → audio2exp になる
   - audio2exp が PCM を受け付けるか確認。受け付けない場合は PCM→WAV 変換が必要:

```python
import io, struct

def pcm_to_wav(pcm_data: bytes, sample_rate: int = 24000, channels: int = 1, bits: int = 16) -> bytes:
    """PCM raw データを WAV 形式に変換"""
    buf = io.BytesIO()
    data_size = len(pcm_data)
    buf.write(b'RIFF')
    buf.write(struct.pack('<I', 36 + data_size))
    buf.write(b'WAVE')
    buf.write(b'fmt ')
    buf.write(struct.pack('<I', 16))
    buf.write(struct.pack('<H', 1))  # PCM
    buf.write(struct.pack('<H', channels))
    buf.write(struct.pack('<I', sample_rate))
    buf.write(struct.pack('<I', sample_rate * channels * bits // 8))
    buf.write(struct.pack('<H', channels * bits // 8))
    buf.write(struct.pack('<H', bits))
    buf.write(b'data')
    buf.write(struct.pack('<I', data_size))
    buf.write(pcm_data)
    return buf.getvalue()
```

3. **既存のゼロ送信コードを特定して置き換えること**
   - 現在「枠だけ送ってデータはゼロ」の状態なので、そのコードを見つけて修正

### 検証方法

修正後、フロントエンドのコンソールログで確認:

```
# ✅ 正常動作時に期待されるログ:
[Live Expr RAW] chunk#1: 30 frames, 52 channels, maxVal=0.3521, jawOpen[24]=0.2104, mouthFunnel[31]=0.1532
[LAM Live] 18/30 frames have non-zero mouth values
[LAM Live-Sync] Frame 10/30: jaw=0.210, mouth=0.081, funnel=0.153, elapsed=333ms

# ❌ 現在のログ（全ゼロ）:
[Live Expr RAW] chunk#1: 789 frames, 52 channels, maxVal=0.0000, jawOpen[24]=0.0000, mouthFunnel[31]=0.0000
[LAM Live] ALL 789 frames have zero mouth values — backend may not be generating expression
```

---

## Expression データ仕様

### フォーマット

```json
{
  "names": ["browDownLeft", "browDownRight", "browInnerUp", ...],
  "frames": [
    [0.01, 0.02, 0.05, ...],
    [0.03, 0.05, 0.08, ...],
    ...
  ],
  "frame_rate": 30
}
```

### チャンネル順序（ARKit 52ch 標準）

フロントエンドは以下の順序を想定。`names` 配列で名前が指定されるため順序は厳密でなくてよいが、
REST TTS と同じ順序であることが望ましい:

```
[0]  browDownLeft       [1]  browDownRight      [2]  browInnerUp
[3]  browOuterUpLeft    [4]  browOuterUpRight    [5]  cheekPuff
[6]  cheekSquintLeft    [7]  cheekSquintRight    [8]  eyeBlinkLeft
[9]  eyeBlinkRight      [10] eyeLookDownLeft     [11] eyeLookDownRight
[12] eyeLookInLeft      [13] eyeLookInRight      [14] eyeLookOutLeft
[15] eyeLookOutRight    [16] eyeLookUpLeft       [17] eyeLookUpRight
[18] eyeSquintLeft      [19] eyeSquintRight      [20] eyeWideLeft
[21] eyeWideRight       [22] jawForward          [23] jawLeft
[24] jawOpen            [25] jawRight            [26] mouthClose
[27] mouthDimpleLeft    [28] mouthDimpleRight    [29] mouthFrownLeft
[30] mouthFrownRight    [31] mouthFunnel         [32] mouthLeft
[33] mouthLowerDownLeft [34] mouthLowerDownRight  [35] mouthPressLeft
[36] mouthPressRight    [37] mouthPucker         [38] mouthRight
[39] mouthRollLower     [40] mouthRollUpper      [41] mouthShrugLower
[42] mouthShrugUpper    [43] mouthSmileLeft      [44] mouthSmileRight
[45] mouthStretchLeft   [46] mouthStretchRight   [47] mouthUpperUpLeft
[48] mouthUpperUpRight  [49] noseSneerLeft       [50] noseSneerRight
[51] tongueOut
```

### 値の範囲

- 各値: `0.0` ～ `1.0`（float）
- フロントエンドで `0.7` にクランプ済み（FLAME メッシュ安定性のため）
- 特に重要なチャンネル（口の動きに直結）:
  - `jawOpen` [24] — 顎の開閉（最も目立つ）
  - `mouthFunnel` [31] — 口のすぼめ（う・お）
  - `mouthSmileLeft/Right` [43-44] — 笑顔（い）
  - `mouthStretchLeft/Right` [45-46] — 口の横伸び（え）
  - `mouthPucker` [37] — 唇の突き出し
  - `mouthLowerDownLeft/Right` [33-34] — 下唇の下降

---

## REST TTS と Live API の違い（実装上の注意）

| 項目 | REST TTS | Live API |
|------|----------|----------|
| 音声ソース | Google Cloud TTS → MP3 | Gemini Live API → PCM 24kHz |
| 音声形式 | MP3（圧縮済み） | PCM 16bit LE（生データ） |
| audio2exp 入力 | MP3 or WAV | PCM → WAV変換が必要かも |
| レスポンス形式 | HTTP JSON（一括） | WebSocket JSON（ストリーミング） |
| タイミング | リクエスト/レスポンス | リアルタイム（チャンクごと） |
| フロント側の同期 | `ttsPlayer.currentTime` | `performance.now()` ベース |

---

## フロントエンド側の対応状況（参考）

バックエンドが正しいデータを返せば、以下の処理が即座に動作:

### REST TTS 経路
```
POST /api/v2/rest/tts/synthesize
  → response.expression を受信
  → applyExpressionFromTts() で名前ベースマッピング
  → 30fps→60fps 補間
  → ttsPlayer.currentTime で同期再生
  → SDK の morphTargetDictionary で描画
```

### Live API 経路
```
WebSocket { type: "expression", data: { names, frames, frame_rate } }
  → handleLiveExpression() で受信
  → queueLiveExpressionFrames() でリアルタイムキューイング
  → performance.now() ベースで同期再生（★今回新規実装）
  → SDK の morphTargetDictionary で描画
```

### フロントエンドの診断ログ（次回デプロイで有効）

| ログプレフィックス | 意味 | 正常時の例 |
|---|---|---|
| `[Live Expr RAW]` | バックエンドからの生データ | `maxVal=0.352, jawOpen=0.210` |
| `[LAM Live]` | 非ゼロフレーム検出 | `18/30 frames have non-zero mouth values` |
| `[LAM Live-Sync]` | リアルタイム再生状態 | `Frame 10/30: jaw=0.210, elapsed=333ms` |
| `[Concierge] Expression:` | REST TTS expression 受信 | `Expression: 30→60 frames` |

---

## 調査結果の報告テンプレート

調査後、以下の情報を共有してください:

```
### 問題A: REST TTS

1. TTS ハンドラ内の audio2exp 呼び出しコード:
   - ファイル: ______________________
   - 行番号: ______________________
   - 状態: [有効 / コメントアウト / 条件分岐で無効 / 存在しない]

2. audio2exp の呼び出し失敗理由（ログから）:
   _________________________________

3. 環境変数:
   - AUDIO2EXP_URL = _________________
   - その他 = _________________________

### 問題B: Live API

1. relay.py の expression 送信コード:
   - ファイル: ______________________
   - 行番号: ______________________
   - 状態: [audio2exp 実呼出し / ダミーデータ / プレースホルダー]

2. Gemini 音声のフォーマット:
   - サンプルレート: ______ Hz
   - ビット深度: ______ bit
   - チャンネル数: ______

3. audio2exp サービスの入力フォーマット:
   - 対応形式: [PCM / WAV / MP3 / その他: ______]
   - エンドポイント: ______________________
```

---

## 完了チェックリスト

### 問題A: REST TTS Expression

- [ ] TTS ハンドラ内の audio2exp 呼び出しコードを特定
- [ ] audio2exp が呼ばれない原因を特定（ログ / コード）
- [ ] 修正適用
- [ ] curl テストで `expression` フィールドが返る（frames が非ゼロ）
- [ ] フロントエンドで初回挨拶時に口が動く

### 問題B: Live API Expression

- [ ] relay.py の expression 送信コードを特定（ゼロ送信の箇所）
- [ ] Gemini 音声の audio2exp 連携を実装 or 有効化
- [ ] 音声フォーマット変換（PCM→WAV 等）が必要な場合は対応
- [ ] フロントエンドのログで `maxVal > 0` を確認
- [ ] 会話中にアバターの口が動く
