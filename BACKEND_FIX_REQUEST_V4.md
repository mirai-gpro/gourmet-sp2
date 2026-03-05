# バックエンド調査・修正依頼書 v4

**日付**: 2026-03-05（問題D 追記）
**対象**: support-base バックエンド（relay.py / REST TTS / audio2exp）
**報告者**: gourmet-sp2 フロントエンドチーム
**ステータス**: 未着手

---

## エグゼクティブサマリ

リップシンク（口の動き）に **4つの未解決問題** が残っている。
いずれもバックエンド側の修正が必要で、フロントエンドでの対処は不可能または不適切。

| # | 問題 | 優先度 | 影響 | 修正箇所 |
|---|------|--------|------|----------|
| **D** | Live API expression のチャンク分割が音声とズレる | **P0** | 発話全体で口と音声がズレ続ける | relay.py チャンク戦略 + Gemini プロンプト |
| **A** | REST TTS の expression が `status=error` | **P0** | 初回挨拶で口が全く動かない | TTS ハンドラ / audio2exp |
| **B** | Live API expression の初回遅延 ~500–1200ms | **P1** | 発話冒頭の口が動かない | relay.py バッファサイズ |
| **C** | Live API expression の末尾欠落 1–2秒 | **P1** | 発話末尾の口が動かない | relay.py turn_complete 処理 |

> **問題D は問題B/C の根本原因であり、D を正しく修正すれば B/C も同時に解決する。**

**補足**: 以下の問題は**解決済み**（対応不要）

| 解決済み | 内容 |
|----------|------|
| ~~Live API expression が全値ゼロ~~ | **解決済み** — maxVal=0.15 確認 |
| ~~Expression が音声終了後に一括到着~~ | **解決済み** — ストリーミング化完了 |
| ~~Live API expression の同期ズレ~~ | **解決済み** — audioStartTime 同期実装 |
| ~~TTS-Sync リプレイ二重再生~~ | **解決済み** — バッファクリア実装 |

---

## 問題A: REST TTS の expression 生成失敗（P0）

### 現象

初回挨拶（セッション開始時のウェルカムメッセージ）で口が一切動かない。

```
[Concierge] TTS response has NO expression data (status=error, session=sess_912e582ab676)
[LAM External] TTS play - frameBuffer has 0 frames
```

REST TTS エンドポイント `/api/v2/rest/tts/synthesize` が `expression` フィールドを返さない、
または `expression_status: "error"` を返している。

### 再現手順

```bash
curl -s -X POST https://support-base-32596857330.us-central1.run.app/api/v2/rest/tts/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text":"こんにちは","language_code":"ja-JP","voice_name":"ja-JP-Chirp3-HD-Leda","session_id":"test"}'
```

**期待するレスポンス**:
```json
{
  "success": true,
  "audio": "<base64>",
  "expression": {
    "names": ["browDownLeft", ..., "tongueOut"],
    "frames": [[0.01, 0.02, ...], ...],
    "frame_rate": 30
  }
}
```

**実際のレスポンス**: `expression` フィールドが欠落、または `expression_status: "error"`

### 想定される原因（優先度順）

1. **audio2exp 呼び出しが try-catch で silent fail している**
   ```python
   # ❌ こうなっていないか
   try:
       expression = await audio2exp(audio)
   except:
       pass  # エラーが握りつぶされている
   ```

2. **TTS 音声（MP3）→ audio2exp 変換時のフォーマットエラー**
   - audio2exp が MP3 を受け付けない場合、WAV/PCM への変換が必要

3. **TTS 音声が短すぎて expression 生成不可**
   - 「こんにちは」は約1秒 — audio2exp が最低入力長を要求している可能性

4. **audio2exp サービスのタイムアウト**
   - Cloud Run のリクエストタイムアウトに引っかかっている

### 調査手順

```bash
# Step 1: Cloud Run ログで expression error の原因を確認
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="support-base" AND textPayload=~"a2e|expression|error"' \
  --limit=30 --format="table(timestamp,textPayload)"

# Step 2: TTS ハンドラの audio2exp 呼び出しコードを確認
grep -n -A 30 "def.*tts\|synthesize" support_base/rest/router.py

# Step 3: エラーハンドリング箇所を確認
grep -n -B2 -A5 "except.*Exception\|except:" support_base/rest/router.py | grep -A5 "a2e\|expression"
```

### 修正方針

```python
# ✅ エラー時のログを詳細化して原因を特定
async def synthesize_tts(request):
    audio_bytes = await google_tts(request.text, ...)

    expression = None
    try:
        expression = await a2e_service.process(audio_bytes)
        logger.info(f"[TTS] audio2exp success: {len(expression['frames'])} frames")
    except Exception as e:
        logger.error(f"[TTS] audio2exp failed: {e}", exc_info=True)
        # ↑ exc_info=True でスタックトレースを出力

    result = {"success": True, "audio": base64_audio}
    if expression and expression.get("frames"):
        result["expression"] = expression
        result["expression_status"] = "ok"
    else:
        result["expression_status"] = "error"
    return result
```

### 検証コマンド

```bash
curl -s -X POST https://support-base-32596857330.us-central1.run.app/api/v2/rest/tts/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text":"こんにちは","language_code":"ja-JP","voice_name":"ja-JP-Chirp3-HD-Leda","session_id":"test"}' \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'expression' in d:
    e = d['expression']
    print(f'OK: {len(e[\"names\"])} channels, {len(e[\"frames\"])} frames')
    max_val = max(max(abs(v) for v in f) for f in e['frames'])
    jaw_vals = [f[24] for f in e['frames']]
    print(f'Max value: {max_val:.4f}, jawOpen avg: {sum(jaw_vals)/len(jaw_vals):.4f}')
else:
    print(f'NG: expression missing (status={d.get(\"expression_status\", \"N/A\")})')
    print(f'Keys: {list(d.keys())}')
"
```

**成功基準**: `OK: 52 channels, XX frames` かつ `Max value > 0.01`

---

## 問題D: Live API expression のチャンク分割による音声同期ズレ（P0）

### 現象

音声と口の動きが**冒頭から**ズレている。発話全体を通じて以下が観測される：

1. **音声の間（無音部分）で口が動き続ける** — 単語が終わってポーズがあるのに口パクが止まらない
2. **音声終了後、約10秒間口が動き続ける** — expression が音声より長い
3. **ズレは冒頭1〜1.5秒で既に知覚できる** — 累積誤差ではなく固定オフセット

### 実測データ

```
expression: 2127 frames / 30fps = 70.9秒
音声:       推定 60秒
ズレ:       約10秒（expression が音声より長い）

★ 冒頭からズレが見える → 各チャンクの先頭にズレがある
```

### 根本原因

**audio2exp への 1.5 秒チャンク分割呼び出し**が問題の根源。

REST TTS（正常）と Live API（異常）の比較：

```
REST（ズレない）:
  完成した音声全体 → audio2exp 1回 → 音声と expression が 1:1 対応

Live（ズレる）:
  1.5秒チャンク#1 → audio2exp → 45フレーム（+ 先頭にオフセット?）
  1.5秒チャンク#2 → audio2exp → 45フレーム（+ 先頭にオフセット?）
  ...
  1.5秒チャンク#40 → audio2exp → 45フレーム（+ 先頭にオフセット?）
  → 40回の独立呼び出し、各回にズレが入る
```

**なぜ REST で合って Live で合わないか？**

1. REST: audio2exp の呼び出しは**1回**。ウォームアップ/パディング/窓関数の影響は1回だけ
2. Live: audio2exp の呼び出しは**40〜50回**。各チャンクが独立呼び出しで前後の文脈を持たない

audio2exp が各チャンクの先頭に 200ms の内部バッファ/ウォームアップを持つ場合：
```
チャンク1: 200ms のズレ（知覚可能）
チャンク40: 200ms × 40 = 8秒のズレ（致命的）
→ 冒頭から知覚でき、かつ最終的に ~10秒のズレになる
```

### 確認すべき事項

relay.py で各チャンクの入力長と出力フレーム数を比較するログを追加:

```python
input_duration = len(audio_chunk) / (24000 * 2)  # 秒
output_frames = len(expression["frames"])
output_duration = output_frames / 30  # 秒
logger.info(
    f"[a2e] chunk#{chunk_idx}: "
    f"input={input_duration:.3f}s, "
    f"output={output_frames} frames ({output_duration:.3f}s), "
    f"diff={output_duration - input_duration:+.3f}s"
)
```

**期待される結果**:
- `diff` が `+0.000s` に近い → audio2exp の出力長は正確（問題は別にある）
- `diff` が `+0.100s` 以上 → **各チャンクで余分なフレームが出ている（これが原因）**

### 修正方針: チャンク分割をやめる

**問題B（初回遅延）と問題C（末尾欠落）の根本解決にもなる。**

#### 方針1: 初回 0.25 秒 + 残りは turn_complete まで一括（推奨）

```python
FIRST_CHUNK_SIZE = 24000 * 2 * 0.25  # 0.25秒 = 12000 bytes（初回のみ小さく）
# 2回目以降: turn_complete まで全バッファを溜めて1回で処理

class ExpressionProcessor:
    def __init__(self):
        self._first_chunk_sent = False
        self._audio_buffer = bytearray()
        self._chunk_idx = 0

    async def on_audio_chunk(self, audio_bytes: bytes):
        self._audio_buffer.extend(audio_bytes)

        if not self._first_chunk_sent:
            # 初回: 0.25秒で即座にリップシンク開始
            if len(self._audio_buffer) >= FIRST_CHUNK_SIZE:
                chunk = bytes(self._audio_buffer)
                self._audio_buffer = bytearray()
                self._first_chunk_sent = True
                self._chunk_idx += 1
                asyncio.create_task(
                    self._send_expression_chunk(chunk, is_final=False)
                )
        # 2回目以降: バッファを溜め続ける（チャンク分割しない）

    async def on_turn_complete(self):
        # 残り全部を1回で処理（REST と同じ精度）
        if self._audio_buffer:
            chunk = bytes(self._audio_buffer)
            self._audio_buffer = bytearray()
            self._chunk_idx += 1
            await self._send_expression_chunk(chunk, is_final=True)

        self._first_chunk_sent = False
        self._chunk_idx = 0
```

#### 方針2: Gemini プロンプトで応答長を制限（併用推奨）

先行プロジェクト（リップシンク成功済み）では、LLM の応答を**15文字以内**に制限したところ
リップシンクが正確に動作した。これは応答が短い = audio2exp の呼び出しが 1〜2 回で済むため。

```python
# Gemini Live API のシステムプロンプトに追加
SYSTEM_PROMPT += """
## 応答の長さ制限
- 1回の応答は原則 **30文字以内**（日本語）
- 長い説明が必要な場合は複数ターンに分ける
- 短い応答の方がユーザーとの対話がテンポよく進む
"""
```

### 方針1+2 の組み合わせ効果

| シナリオ | audio2exp 呼び出し回数 | ズレ |
|----------|----------------------|------|
| 現在（1.5秒チャンク × 40回） | 40回 | 〜10秒 |
| 方針1のみ（初回0.25秒 + 残り一括） | 2回 | ≒ 0（REST同等） |
| 方針2のみ（応答30文字 ≈ 2-4秒） | 2〜3回 | 〜0.5秒 |
| **方針1+2 併用** | **1〜2回** | **≒ 0** |

### 方針1+2 のリスクと対策

| リスク | 発生条件 | 対策 |
|--------|---------|------|
| 方針1で2回目チャンクが大きすぎる | 応答が長い（30秒以上） | 方針2でプロンプト制限 |
| 方針2でユーザー体験が損なわれる | 短すぎて不自然な応答 | 30文字（15文字より緩い）で調整 |
| a2e が長い音声を処理できない | 入力上限がある場合 | 10秒上限のフォールバック分割 |

```python
# フォールバック: 方針1 で残りバッファが 10秒を超えた場合のみ分割
MAX_BUFFER_SIZE = 24000 * 2 * 10  # 10秒 = 480000 bytes

async def on_audio_chunk(self, audio_bytes: bytes):
    self._audio_buffer.extend(audio_bytes)

    if not self._first_chunk_sent:
        if len(self._audio_buffer) >= FIRST_CHUNK_SIZE:
            # 初回 0.25秒
            chunk = bytes(self._audio_buffer)
            self._audio_buffer = bytearray()
            self._first_chunk_sent = True
            asyncio.create_task(self._send_expression_chunk(chunk, is_final=False))
    elif len(self._audio_buffer) >= MAX_BUFFER_SIZE:
        # 安全弁: 10秒を超えたら分割（通常はプロンプト制限で到達しない）
        chunk = bytes(self._audio_buffer)
        self._audio_buffer = bytearray()
        asyncio.create_task(self._send_expression_chunk(chunk, is_final=False))
```

### 検証方法

```
# 改善前
[a2e] chunk#1: input=1.500s, output=46 frames (1.533s), diff=+0.033s
[a2e] chunk#2: input=1.500s, output=46 frames (1.533s), diff=+0.033s
... (×40回)
→ 累積 +1.3s ～ +10s のズレ

# 改善後（方針1+2 併用）
[a2e] chunk#1: input=0.250s, output=8 frames (0.267s), diff=+0.017s   ← 初回 0.25秒
[a2e] chunk#2: input=2.500s, output=75 frames (2.500s), diff=+0.000s  ← 残り一括
→ ズレ ≒ 0 (REST 同等)
```

ブラウザコンソールで確認:
```
# 改善前
[LAM Live-Sync] Frame 30/2127: elapsed=1010ms   ← 2127フレーム（70.9秒分）

# 改善後
[LAM Live-Sync] Frame 30/83: elapsed=1010ms     ← 83フレーム（2.8秒分）
# ↑ 応答が短い + 分割なし = フレーム総数が音声秒数に一致
```

---

## 問題B: Live API expression の初回遅延（P1）

> **注: 問題D の方針1（初回 0.25 秒バッファ）を実装すれば、この問題は自動的に解決する。**
> 問題D の修正が先に入る場合、本セクションの修正は不要。

### 現象

音声再生開始から expression 到着まで **500〜1200ms の遅延**がある。
この間、音声は聞こえるが口が動かない。

```
# Turn 1: 539ms 遅延
[Core] First audio chunk received at 23580ms          ← 音声再生開始
[LAM Live] Stream started — synced to audio start (535ms ago)  ← 535ms後にexpression到着
→ 最初の16フレーム（~530ms）分は口が動かない

# Turn 2: 1237ms 遅延（悪化）
[Core] First audio chunk received at 45422ms
[LAM Live] Stream started — synced to audio start (1237ms ago)
→ 最初の37フレーム（~1230ms）分は口が動かない — ほぼ最初のチャンク全体がスキップ
```

**Turn 2 で遅延が悪化する原因**: Turn 1 の audio2exp 処理がまだ完了していない可能性。

### 根本原因

`relay.py` が **1.5秒分の音声をバッファ**してから audio2exp に送信している。

```python
# 現在の実装（推定）
CHUNK_SIZE = 24000 * 2 * 1.5  # 1.5秒分 = 72000 bytes
```

```
時間軸:
0.0s  音声チャンク到着 → クライアントへ即送信（再生開始）
      ↓ バッファリング中（口は動かない）
1.5s  バッファ full → audio2exp 処理開始
      ↓ audio2exp 処理時間 (~100-200ms)
1.7s  expression チャンク#1 → クライアントへ送信
      ↓ フロントエンドで 535ms スキップ（既に音声が先行しているため）
      → 実質的に最初の ~500ms 分の口の動きが欠落
```

### 修正方針

バッファサイズを **1.5秒 → 0.75秒** に縮小する。

```python
# 現在
CHUNK_SIZE = 24000 * 2 * 1.5  # 1.5秒分 = 72000 bytes

# 改善案
CHUNK_SIZE = 24000 * 2 * 0.75  # 0.75秒分 = 36000 bytes
# → expression の初回到着が ~750ms → ~375ms に短縮
```

### トレードオフ

| 項目 | 1.5秒（現在） | 0.75秒（推奨） | 0.5秒 |
|------|------------|------------|-------|
| 初回遅延 | ~500-1200ms | ~250-600ms | ~170-400ms |
| audio2exp 精度 | 高い | 十分 | やや低下の可能性 |
| API コール数 | 基準 | 2倍 | 3倍 |
| 推奨度 | — | **推奨** | 精度確認が必要 |

**提案**: まず **0.75秒** で試し、精度に問題なければそのまま採用。
精度が問題なら **1.0秒** に妥協。

### Turn 2 遅延悪化の対策

Turn 間で audio2exp の処理キューが詰まらないよう、以下を確認:

```python
# asyncio.create_task() で非同期処理していることを確認
# 前のタスクが完了していなくても次のバッファ処理を開始できるようにする
asyncio.create_task(self._send_expression_chunk(chunk))
# ↑ await しない（音声転送をブロックしない）
```

### 検証方法

```
# 改善前（現在）
[LAM Live] Stream started — synced to audio start (535ms ago)

# 改善後（期待値）
[LAM Live] Stream started — synced to audio start (250ms ago)  ← 250ms 以下が理想
```

---

## 問題C: Live API expression の末尾欠落（P1）

> **注: 問題D の方針1（turn_complete で残りバッファ一括送信）を実装すれば、この問題は自動的に解決する。**
> 問題D の修正が先に入る場合、本セクションの修正は不要。

### 現象

音声の最後の **1〜2秒間**、expression が欠落する。
音声は再生中だが口が止まる。

```
[LAM Live] +40 frames (total: 310) at 30fps       ← 最後のチャンク（40フレーム）
[LAM Live] Stream ended (no new chunks for 2014ms) ← 2秒後にストリーム終了
```

**310フレーム / 30fps = 10.33秒分** の expression だが、音声は推定 **11〜12秒**。
最後の 0.7〜1.7 秒分の expression が存在しない。

### 根本原因

`turn_complete` 時にバッファに残っている音声（1.5秒未満）が **処理されずに破棄されている**。

```
時間軸:
...
10.0s  audio2exp チャンク#7 送信（1.5秒分）
10.5s  バッファに 0.5秒分の音声が残る
11.0s  turn_complete 到着
       → バッファの 0.5秒分は CHUNK_SIZE 未満のため送信されない ← ★ここが問題
       → 最後の 0.5秒分（+ audio2exp 処理時間分）の expression が欠落
```

### 修正方針

`turn_complete` 時に残りバッファを **チャンクサイズ未満でも強制的に** audio2exp に送信する。

```python
if sc.turn_complete:
    # ★ 残りのバッファも処理（短くても送信）
    if self._audio_buffer:
        chunk = bytes(self._audio_buffer)
        self._audio_buffer = bytearray()
        # is_final=True で audio2exp に最終チャンクであることを伝える
        await self._send_expression_chunk(chunk, is_final=True)
    self._total_audio_bytes = 0

    # turn_complete をクライアントに送信
    await self.websocket.send_json({"type": "turn_complete"})
```

**重要**: `is_final=True` を audio2exp に渡すことで、短い音声チャンクでも
expression を生成するよう指示する。

### 検証方法

```
# 改善前
expression: 310 frames / 30fps = 10.33秒
音声: 推定 11-12秒
→ 末尾 0.7-1.7秒分が欠落

# 改善後（期待値）
expression: ~360 frames / 30fps = 12.0秒
音声: 推定 11-12秒
→ expression と音声の総秒数が一致（誤差 ±0.5秒以内）
```

ブラウザコンソールで確認:
```
[LAM Live] Stream ended (no new chunks for 2014ms)
[LAM Live] Total: XXX frames / 30fps = YY.Y秒
# ↑ YY.Y ≒ 音声の総秒数 であること
```

---

## 補足: jawOpen 値の振幅について（任意対応）

### 現状のデータ

```
jawOpen の値分布（実測）:
  0.00-0.05: ████████████████████████████  78%  ← ほぼ閉口
  0.05-0.10: ████                           11%
  0.10-0.20: ███                             8%
  0.20-0.30: █                               3%  ← ここだけ口が開いて見える
  平均: ~0.03  最大: 0.287
```

jawOpen=0.03 は視覚的にほぼ口が閉じた状態。音声が聞こえても口が動いて見えない場面が多い。

### 改善案（任意）

audio2exp の出力パラメータで jawOpen のスケールを調整可能であれば、
**1.5〜2.0倍** にすると口の動きが視覚的に改善する。

```python
# audio2exp の設定（もし調整可能なら）
jawOpen_scale = 1.5  # or 2.0

# または後処理で増幅
for frame in expression["frames"]:
    frame[24] = min(frame[24] * 1.5, 0.7)  # jawOpen を 1.5倍、0.7 でクランプ
```

> **注**: フロントエンドでも増幅は可能だが、バックエンドで出力スケールを
> 調整する方が、他のクライアントにも恩恵があり望ましい。
> ただしこの対応は **任意** であり、問題A/B/C の修正が優先。

---

## 全体のデータフロー図

```
┌─────────────────── REST TTS 経路（問題A）──────────────────────┐
│                                                                │
│  POST /api/v2/rest/tts/synthesize                              │
│       ↓                                                        │
│  Google Cloud TTS → MP3 音声                                    │
│       ↓                                                        │
│  audio2exp(MP3) → expression  ← ★ ここが status=error          │
│       ↓                                                        │
│  JSON { audio, expression } → フロントエンド                     │
│                                                                │
└────────────────────────────────────────────────────────────────┘

┌─────────────────── Live API 経路（問題B, C）────────────────────┐
│                                                                │
│  Gemini Live API → PCM 24kHz 音声チャンク（リアルタイム）        │
│       ↓                    ↓                                   │
│  ① クライアントへ即送信    ② バッファリング（1.5秒分）           │
│   （音声再生開始）              ↓                               │
│                           バッファ full?                        │
│                           ├─ Yes → audio2exp(PCM) → expression │
│                           │        → クライアントへ送信          │
│                           └─ No → バッファ継続                  │
│                                                                │
│  turn_complete 到着                                             │
│       ↓                                                        │
│  残りバッファ → ★ 現在は破棄（問題C）                           │
│                 → 修正後: audio2exp に強制送信                   │
│                                                                │
│  ★ 問題B: 初回バッファリング 1.5秒が長すぎて遅延                │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## Expression データ仕様（参考）

### WebSocket メッセージフォーマット

```json
{
  "type": "expression",
  "data": {
    "names": ["browDownLeft", "browDownRight", ..., "tongueOut"],
    "frames": [[0.01, 0.02, ..., 0.00], [0.03, 0.05, ..., 0.00], ...],
    "frame_rate": 30
  }
}
```

### ARKit 52ch — 口の動きに関わる主要チャンネル

| Index | Name | 役割 |
|-------|------|------|
| **24** | **jawOpen** | 顎の開閉（最も目立つ） |
| 31 | mouthFunnel | 口のすぼめ（「う」「お」） |
| 33-34 | mouthLowerDownLeft/Right | 下唇の下降 |
| 37 | mouthPucker | 唇の突き出し |
| 43-44 | mouthSmileLeft/Right | 笑顔（「い」） |
| 45-46 | mouthStretchLeft/Right | 口の横伸び（「え」） |

### 値の範囲

- 各値: `0.0` 〜 `1.0`（float）
- フロントエンドで `0.7` にクランプ済み（FLAME メッシュ安定性のため）

---

## 調査結果の報告テンプレート

修正着手前に、以下の情報を共有いただけると助かります。

```
### 問題A: REST TTS expression=error

1. TTS ハンドラ内の audio2exp 呼び出しコード:
   - ファイル: ______________________
   - 行番号: ______________________
   - 状態: [有効 / コメントアウト / 条件分岐で無効 / 存在しない]

2. Cloud Run ログで確認したエラー内容:
   _________________________________

3. audio2exp の入力フォーマット:
   - 対応形式: [PCM / WAV / MP3 / その他: ______]

### 問題B/C: Live API タイミング

1. relay.py のバッファサイズ設定:
   - 現在値: ______ bytes (______ 秒)

2. turn_complete 時の残りバッファ処理:
   - [処理している / 破棄している / 処理なし]
```

---

## 完了チェックリスト

### P0: 問題D — Live API チャンク分割による音声同期ズレ

- [ ] relay.py でチャンク入力長 vs 出力フレーム数の比較ログを追加し、ズレ量を確認
- [ ] 方針1: 初回 0.25 秒チャンク + 残りは turn_complete まで一括に変更
- [ ] 方針2: Gemini システムプロンプトに 30 文字以内の応答制限を追加
- [ ] フォールバック: 10 秒超の場合のみ分割するガードを追加
- [ ] ブラウザで確認: 音声再生と口の動きが冒頭からズレないこと
- [ ] ブラウザで確認: 音声終了後に口が動き続けないこと（±0.5 秒以内に停止）
- [ ] `a2e` 呼び出し回数が 1〜2 回であること（40 回ではない）

### P0: 問題A — REST TTS expression

- [ ] Cloud Run ログで `expression_status=error` の原因を特定
- [ ] audio2exp 呼び出しのエラーを修正（or ログ詳細化で原因特定）
- [ ] curl テストで `expression` フィールドが返る
- [ ] expression の `frames` が非ゼロ値を含む（maxVal > 0.01）

### P1: 問題B — Live API 初回遅延（問題D で自動解決）

- [ ] ~~relay.py のバッファサイズを **1.5秒 → 0.75秒** に縮小~~ → 問題D の方針1 で解決
- [ ] フロントエンドの初回遅延が **250ms 以下** に改善
- [ ] Turn 2 以降で遅延が悪化しないことを確認

### P1: 問題C — Live API 末尾欠落（問題D で自動解決）

- [ ] ~~`turn_complete` 時に残りバッファを `is_final=True` で audio2exp に送信~~ → 問題D の方針1 で解決
- [ ] `turn_complete` 後に偽のゼロチャンクを送信しないことを確認
- [ ] expression の総フレーム数 / 30fps ≒ 音声の総秒数（誤差 ±0.5秒）

### 任意: jawOpen スケーリング

- [ ] audio2exp の jawOpen 出力スケールを確認（調整可能か）
- [ ] 可能であれば 1.5〜2.0倍に増幅

---

## デプロイ後の検証コマンド

```bash
# === 問題A: REST TTS expression ===
curl -s -X POST https://support-base-32596857330.us-central1.run.app/api/v2/rest/tts/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text":"こんにちは、いらっしゃいませ。グルメコンシェルジュです。","language_code":"ja-JP","voice_name":"ja-JP-Chirp3-HD-Leda","session_id":"test"}' \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'expression' in d and d['expression']:
    e = d['expression']
    n_frames = len(e['frames'])
    max_val = max(max(abs(v) for v in f) for f in e['frames'])
    jaw_avg = sum(f[24] for f in e['frames']) / n_frames
    print(f'PASS: {len(e[\"names\"])} channels, {n_frames} frames, maxVal={max_val:.4f}, jawOpen_avg={jaw_avg:.4f}')
else:
    print(f'FAIL: expression missing or empty (status={d.get(\"expression_status\",\"N/A\")})')
"

# === 問題D: Live API チャンク分割 — サーバーログで確認 ===
# relay.py のログで以下を確認:
#
# [a2e] chunk#1: input=0.250s, output=8 frames (0.267s), diff=+0.017s
# [a2e] chunk#2: input=2.500s, output=75 frames (2.500s), diff=+0.000s
#   → チャンク数が 1〜2 回であること（40回ではない）
#   → diff が ±0.1s 以内であること
#
# ブラウザコンソールで以下を確認:
# [LAM Live-Sync] Frame 30/83: elapsed=1010ms
#   → フレーム総数 / 30fps ≒ 音声の総秒数（±0.5秒以内）

# === 問題B/C: Live API — ブラウザコンソールで確認 ===
# 以下のログが出力されることを確認:
#
# [LAM Live] Stream started — synced to audio start (XXXms ago)
#   → XXX が 250ms 以下であること（問題B の改善）
#
# [LAM Live] Stream ended — Total: YYY frames / 30fps = ZZ.Zs
#   → ZZ.Z ≒ 音声の総秒数（問題C の改善）
```
