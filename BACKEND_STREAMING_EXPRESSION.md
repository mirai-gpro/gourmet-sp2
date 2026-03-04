# バックエンド修正依頼: Expression ストリーミング化

> **日付**: 2026-03-04
> **対象**: support-base `relay.py`
> **優先度**: P0（リップシンクが音声と同期しない）
> **前提**: `is_start/is_final` フラグ修正は適用済み（expression 値は非ゼロ）

---

## 現状の問題

### 問題1: Live API expression が音声終了後に一括到着

**relay.py の現在の動作**:
```
t=0s   音声チャンク#1 → クライアントへ送信（即座に再生開始）
t=0.1s 音声チャンク#2 → クライアントへ送信
...
t=18s  音声チャンク#N → クライアントへ送信（音声再生完了）
t=18s  turn_complete → 全音声を audio2exp に一括送信
t=19s  expression (546フレーム) → クライアントへ一括送信 ← ★ここでようやく口が動く
```

**結果**: 音声は 0〜18秒で再生完了するが、口が動くのは 19〜37秒。完全にズレている。

**フロントエンド側の暫定対策**:
音声再生開始時刻を記録し、expression 到着時にその時刻を基準に同期開始（経過フレームはスキップ）。
→ しかし全フレームがスキップされるため、事実上口は動かない。

### 問題2: REST TTS の expression が status=error

```
[Concierge] TTS response has NO expression data (status=error, session=sess_47e9a22b9088)
```

初回挨拶の TTS で expression 生成に失敗。ログで原因を確認してください。

---

## 修正方針: relay.py の Expression ストリーミング化

### 概要

音声チャンクを受信するたびに audio2exp に送信し、結果を即座にクライアントへ転送する。

### 修正コード

```python
# relay.py

class LiveRelay:
    def __init__(self, ...):
        self._audio_buffer = bytearray()        # 音声バッファ
        self._audio_buffer_start_idx = 0         # バッファ開始のフレームインデックス
        self._total_audio_bytes = 0              # 累計音声バイト数
        self._expression_task: asyncio.Task | None = None

    async def _recv_from_gemini(self):
        """Gemini からの応答を受信し、クライアントへ転送"""
        async for response in self.gemini_session:
            sc = response.server_content
            if not sc:
                if hasattr(response, 'tool_call') and response.tool_call:
                    logger.warning(f"[LiveRelay] Tool call not implemented: {response.tool_call}")
                continue

            for part in sc.parts:
                if part.inline_data:
                    audio_data = part.inline_data.data

                    # 1. クライアントへ音声送信（即座）
                    await self.websocket.send_json({
                        "type": "audio",
                        "data": base64.b64encode(audio_data).decode()
                    })

                    # 2. audio2exp 用にバッファリング
                    self._audio_buffer.extend(audio_data)
                    self._total_audio_bytes += len(audio_data)

                    # 3. 1秒分溜まったら expression 生成・送信
                    BYTES_PER_SEC = 24000 * 2  # 24kHz * 16bit
                    if len(self._audio_buffer) >= BYTES_PER_SEC:
                        chunk = bytes(self._audio_buffer)
                        self._audio_buffer = bytearray()
                        # 非同期で処理（音声転送をブロックしない）
                        asyncio.create_task(
                            self._send_expression_chunk(chunk, is_first=self._total_audio_bytes <= BYTES_PER_SEC * 2)
                        )

            if sc.turn_complete:
                # 残りのバッファも処理
                if self._audio_buffer:
                    chunk = bytes(self._audio_buffer)
                    self._audio_buffer = bytearray()
                    await self._send_expression_chunk(chunk, is_final=True)
                self._total_audio_bytes = 0

    async def _send_expression_chunk(
        self,
        audio_chunk: bytes,
        is_first: bool = False,
        is_final: bool = False
    ):
        """音声チャンクから expression を生成してクライアントへ送信"""
        try:
            result = await self.a2e_client.process_audio(
                audio_data=audio_chunk,
                sample_rate=24000,
                is_start=is_first,
                is_final=is_final,
            )
            if result and result.get("frames"):
                await self.websocket.send_json({
                    "type": "expression",
                    "data": {
                        "names": result["names"],
                        "frames": result["frames"],
                        "frame_rate": result.get("frame_rate", 30)
                    }
                })
                non_zero = sum(
                    1 for f in result["frames"]
                    if any(abs(v) > 0.01 for v in (f if isinstance(f, list) else f.get("weights", [])))
                )
                logger.info(
                    f"[LiveRelay] Expression chunk sent: "
                    f"{len(result['frames'])} frames ({non_zero} non-zero)"
                )
        except Exception as e:
            logger.error(f"[LiveRelay] a2e chunk error: {e}", exc_info=True)
```

### 重要なポイント

1. **`asyncio.create_task()` で非同期処理**
   - audio2exp 呼び出しが音声転送をブロックしないようにする
   - 音声は遅延なく送信、expression は少し遅れても OK（フロントで同期）

2. **1秒単位でチャンク化**
   - `24000 * 2 = 48000 bytes` ≒ 1秒分の PCM 24kHz 16bit
   - 短すぎると audio2exp のオーバーヘッドが大きい、長すぎると遅延が増える
   - 1秒は良いバランス

3. **`is_start` / `is_final` フラグ**
   - 最初のチャンクには `is_start=True`
   - ターン終了時の最後のチャンクには `is_final=True`
   - これが a2e_client.py で必要だったフラグ

4. **PCM フォーマットに注意**
   - Gemini Live API の音声出力: PCM 24kHz 16bit LE mono
   - audio2exp が WAV ヘッダーを要求する場合は変換が必要:

```python
import io, struct

def pcm_to_wav(pcm_data: bytes, sr: int = 24000) -> bytes:
    buf = io.BytesIO()
    buf.write(b'RIFF')
    buf.write(struct.pack('<I', 36 + len(pcm_data)))
    buf.write(b'WAVEfmt ')
    buf.write(struct.pack('<IHHIIHH', 16, 1, 1, sr, sr * 2, 2, 16))
    buf.write(b'data')
    buf.write(struct.pack('<I', len(pcm_data)))
    buf.write(pcm_data)
    return buf.getvalue()
```

---

## フロントエンド側の対応状況

フロントエンドは**ストリーミング対応済み**。複数チャンクが来れば自動的にバッファに追加して再生:

```
chunk#1 (30 frames) → queueLiveExpressionFrames() → バッファに追加、再生開始
chunk#2 (30 frames) → queueLiveExpressionFrames() → バッファに追加、続行
chunk#3 (30 frames) → queueLiveExpressionFrames() → バッファに追加、続行
...
2秒間新チャンクなし → ストリーム終了
```

各チャンクに `_audioStartTime` を付与しているが、ストリーミング時は最初のチャンクが音声とほぼ同時に届くため、`performance.now()` で十分。

---

## 検証方法

### サーバーログ

修正後、以下のログが1秒間隔で出力されるはず:
```
[LiveRelay] Expression chunk sent: 30 frames (25 non-zero)
[LiveRelay] Expression chunk sent: 30 frames (28 non-zero)
[LiveRelay] Expression chunk sent: 30 frames (22 non-zero)
...
```

### ブラウザコンソール

```
[Live Expr RAW] chunk#1: 30 frames, 52 channels, maxVal=0.3521
[LAM Live] Stream started — first 30 frames at 30fps
[LAM Live] 25/30 frames have non-zero mouth values
[Live Expr RAW] chunk#2: 30 frames, 52 channels, maxVal=0.4102
[LAM Live] +30 frames (total: 60) at 30fps
[LAM Live] 28/30 frames have non-zero mouth values
...
```

→ **chunk#1, #2, #3... と複数チャンクが来ること** = ストリーミング成功

---

## REST TTS expression_status=error の調査

ログで確認:
```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="support-base" AND textPayload=~"A2E|a2e|expression|tts"' \
  --limit=30 --format="table(timestamp,textPayload)"
```

想定される原因:
- TTS の音声フォーマット（MP3）と audio2exp の入力フォーマットの不一致
- audio2exp サービスのタイムアウト
- TTS 音声が短すぎて expression 生成できない

---

## 完了チェックリスト

- [ ] relay.py: 音声チャンクを1秒ごとに audio2exp に送信するように変更
- [ ] relay.py: `asyncio.create_task()` で非同期処理（音声転送をブロックしない）
- [ ] relay.py: `is_start` / `is_final` フラグを適切に設定
- [ ] ブラウザで複数チャンクが到着することを確認（chunk#1, #2, #3...）
- [ ] リップシンクが音声と同時に動くことを確認
- [ ] REST TTS の expression_status=error を調査・修正
