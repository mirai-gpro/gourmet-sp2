# リップシンク改善依頼書（v3）

**日付**: 2026-03-04（第3版）
**対象**: support-base バックエンド（relay.py + REST TTS）
**報告者**: フロントエンド調査チーム
**優先度**: P1（リップシンクは動作するが品質に問題あり）

---

## 解決済みの問題

| # | 問題 | 状態 |
|---|------|------|
| ~~A~~ | ~~Live API expression が全値ゼロ~~ | **解決済み** maxVal=0.15 |
| ~~B~~ | ~~Expression が音声終了後に一括到着~~ | **解決済み** ストリーミング化完了 |
| ~~C~~ | ~~Live API expression の同期ズレ~~ | **解決済み** audioStartTime 同期 |
| ~~D~~ | ~~TTS-Sync リプレイによる二重再生~~ | **解決済み** バッファクリア |

### 動作確認ログ（2026-03-04 最新）

```
[Live Expr RAW] chunk#1: 45 frames, 52 channels, maxVal=0.1358, jawOpen[24]=0.0150
[Live Expr RAW] chunk#2: 45 frames, 52 channels, maxVal=0.1538, jawOpen[24]=0.0134
[Live Expr RAW] chunk#3: 45 frames, 52 channels, maxVal=0.1481, jawOpen[24]=0.0013
... 計6チャンク、310フレーム（~10.3秒分）
→ ストリーミング・非ゼロ値・タイミング同期、すべて正常動作
```

---

## 残存する問題（3件）

### 問題1: REST TTS の expression が status=error（P0）

**現象**:
```
[Concierge] TTS response has NO expression data (status=error, session=sess_912e582ab676)
[LAM External] TTS play - frameBuffer has 0 frames  ← 初回挨拶で口が全く動かない
```

初回挨拶（セッション開始時のウェルカムメッセージ）は REST TTS 経路を使う。
この経路で expression 生成が失敗するため、最初の挨拶で口が一切動かない。

**影響**: ユーザーの第一印象に直結。最初の挨拶で口が動かないとバグに見える。

**調査ポイント**:
```bash
# Cloud Run ログで expression error の原因を確認
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="support-base" AND textPayload=~"a2e|expression|error"' \
  --limit=30 --format="table(timestamp,textPayload)"
```

**想定される原因**:
- TTS 音声（MP3）→ audio2exp 変換時のフォーマットエラー
- audio2exp サービスのタイムアウト
- TTS 音声が短すぎて expression 生成不可（「こんにちは」は ~1秒）
- try-catch で silent fail しており、`expression_status: "error"` だけ返している

**修正方針**:
```python
# エラー時のログを詳細化して原因を特定
try:
    expression = await a2e_service.process(audio_bytes)
except Exception as e:
    logger.error(f"[TTS] audio2exp failed: {e}", exc_info=True)
    # ↑ exc_info=True でスタックトレースを出力
```

---

### 問題2: Live API expression の初回遅延 ~500ms（P2）

**現象**:
```
[Core] First audio chunk received at 23580ms          ← 音声再生開始
[LAM Live] Stream started — synced to audio start (535ms ago)  ← 535ms後にexpression到着
→ 最初の15フレーム（~500ms）分は口が動かない
```

**原因**: relay.py が 1.5秒分（BYTES_PER_SEC * 1.5 = 72000 bytes）の音声をバッファしてから
audio2exp に送信するため、最初の expression チャンクが ~500ms 遅れて到着する。

**影響**: 会話の最初の0.5秒間、音声は聞こえるが口が動かない。

**改善案**: バッファサイズを **1.5秒 → 0.75秒** に縮小:
```python
# 現在
CHUNK_SIZE = 24000 * 2 * 1.5  # 1.5秒分 = 72000 bytes

# 改善
CHUNK_SIZE = 24000 * 2 * 0.75  # 0.75秒分 = 36000 bytes
# → expression の到着が ~250ms 早まる
```

**トレードオフ**:
- チャンクが短いと audio2exp の精度が下がる可能性
- audio2exp API コール数が増加（1.5秒チャンクの2倍）
- まず 1.0秒で試して品質を確認することを推奨

---

### 問題3: Live API expression の末尾欠落（P2）

**現象**:
```
[LAM Live] +40 frames (total: 310) at 30fps       ← 最後のチャンク（40フレーム）
[LAM Live] Stream ended (no new chunks for 2014ms) ← 2秒後にストリーム終了
... でも音声バッファにはまだ再生中のデータがある可能性
```

310フレーム / 30fps = 10.33秒分の expression だが、音声は ~11-12秒の場合がある。
最後の 1-2秒間、音声は再生中だが口が動かない。

**原因**: `turn_complete` 時にバッファに残っている音声が少なすぎて
audio2exp が有効な expression を生成できない、またはそもそも処理されていない。

**改善案**: `turn_complete` 時に残りバッファを強制的に処理:
```python
if sc.turn_complete:
    # 残りのバッファも処理（短くても送信）
    if self._audio_buffer:
        chunk = bytes(self._audio_buffer)
        self._audio_buffer = bytearray()
        # is_final=True で audio2exp に最終チャンクであることを伝える
        await self._send_expression_chunk(chunk, is_final=True)
    self._total_audio_bytes = 0
```

---

## 補足: jawOpen 値の範囲について

現在の audio2exp の出力で、jawOpen は 0.01~0.35 の範囲。
フロントエンドは 0.7 でクランプしているため、jawOpen=0.35 は見た目上 50% の開口。
これは許容範囲だが、もし audio2exp のパラメータで出力スケールを調整できるなら
jawOpen を 1.5倍にすると見栄えが改善する可能性がある。

ただし、これはフロントエンドでの乗算でも対応可能なため、バックエンド対応は**任意**。

---

## フロントエンド側の対応状況

| 項目 | 状態 |
|---|---|
| REST TTS Expression 受信・適用 | 実装済み（バックエンドが返せば即動作） |
| Live API Expression ストリーミング受信 | 実装済み・動作確認済み |
| Live API リアルタイム audioStartTime 同期 | 実装済み・動作確認済み |
| 30fps→60fps 補間（REST TTS） | 実装済み |
| フェードイン/アウト | 実装済み（6フレーム 200ms） |
| TTS-Sync リプレイ抑止 | 修正済み |
| FLAME LBS 安全クランプ | 実装済み（max 0.7） |
| barge-in 時の Live Stream 停止 | 実装済み |

---

## 検証方法

### 問題1（REST TTS expression=error）

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
    print(f'Max value: {max_val:.4f} (should be > 0)')
else:
    print('NG: expression field missing')
    print('Keys:', list(d.keys()))
"
```

### 問題2・3（Live API タイミング改善）

ブラウザコンソールで以下を確認:
```
# 改善前（現在）
[LAM Live] Stream started — synced to audio start (535ms ago)  ← 535ms 遅延

# 改善後（期待値）
[LAM Live] Stream started — synced to audio start (250ms ago)  ← 250ms に短縮

# 末尾: 最後のチャンクが turn_complete 後すぐに到着すること
[LAM Live] +XX frames (total: YYY) at 30fps
# ↑ YYY / 30 ≒ 音声の総秒数 であること
```

---

## 完了チェックリスト

### P0: REST TTS expression
- [ ] Cloud Run ログで expression_status=error の原因を特定
- [ ] audio2exp 呼び出しのエラーを修正
- [ ] curl テストで `expression` フィールドが返る（frames が非ゼロ）
- [ ] フロントエンドで初回挨拶時に口が動く

### P2: Live API タイミング改善
- [ ] 初回チャンクのバッファサイズを 1.5秒 → 0.75~1.0秒 に縮小
- [ ] `turn_complete` 時に残りバッファの強制処理を確認
- [ ] フロントエンドの初回遅延が ~250ms に改善
- [ ] 音声終了と expression 終了のタイミングが一致

### 任意: jawOpen スケーリング
- [ ] audio2exp の jawOpen 出力スケールを確認（調整可能か）
