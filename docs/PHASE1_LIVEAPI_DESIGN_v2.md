# Phase1 設計書: REST API → LiveAPI 移行（v2）

**作成日**: 2026-03-08
**ステータス**: レビュー待ち
**ベース**: 現在の gourmet-sp2 コード（LiveAPI実装済み）
**参照実装**: `docs/stt_stream.py`（本番稼働中の会議アシスタント）

---

## 🚨 原則7 宣言: AIの知識が不足している領域

> **Gemini Live API（`gemini-2.5-flash-native-audio-preview-12-2025`）は2024年末〜2025年初頭にリリースされた新しいAPIです。**
> AIアシスタントはこのAPIの正確な仕様を十分に学習していない可能性があります。
> **判断に迷った場合は、必ず `docs/stt_stream.py` の実装を正とし、推測でコードを書かないこと。**

---

## 1. 現状分析と修正方針

### 1-1. 現在のコードの評価

| 項目 | 現在の実装 (live_session.py) | stt_stream.py (正) | 判定 |
|------|---------------------------|-------------------|------|
| モデル名 | `gemini-2.5-flash-native-audio-preview-12-2025` | 同じ | ✅ 一致 |
| SEND_SAMPLE_RATE | 16000 | 16000 | ✅ 一致 |
| RECEIVE_SAMPLE_RATE | 24000 | 24000 | ✅ 一致 |
| audio mime_type | `audio/pcm` | `audio/pcm` | ✅ 一致 |
| send_realtime_input | `session.send_realtime_input(audio=msg)` | 同じ | ✅ 一致 |
| send_tool_response | `session.send_tool_response(function_responses=[...])` | 同じ | ✅ 一致 |
| tool_call検知 | `response.tool_call` | `response.tool_call` | ✅ 一致 |
| context_window_compression | 32000 tokens | 32000 tokens | ✅ 一致 |
| VAD sensitivity | HIGH/HIGH | HIGH/HIGH | ✅ 一致 |
| **prefix_padding_ms** | **500** | **100** | 🚨 **乖離** |
| **セッション再接続** | **なし** | **800文字累積で再接続** | 🚨 **欠落** |
| **会話履歴追跡** | **なし** | **直近20ターン保持** | 🚨 **欠落** |
| **発話途切れ検知** | **なし** | **`_is_speech_incomplete()`** | 🚨 **欠落** |
| **トランスクリプトバッファリング** | **なし（即時送信）** | **バッファ蓄積→turn_completeで一括** | ⚠️ 差異あり（現在の方式でも動作） |

### 1-2. 修正の優先度

**P0（必須修正）:**
1. `prefix_padding_ms`: 500 → 100 に修正
2. セッション再接続ロジックの追加

**P1（推奨修正）:**
3. 会話履歴追跡の追加（再接続時のコンテキスト引き継ぎ用）
4. コンシェルジュモードの初期挨拶をLiveAPIで生成

**P2（Phase1では対応しない）:**
- フロントエンドの大幅変更（現在の実装で動作している）
- 音声フォーマットの変更

---

## 2. バックエンド修正仕様

### 2-1. `live_session.py` 修正箇所

#### 修正① prefix_padding_ms の修正

🚨 **変更禁止値と混同しやすい箇所**

```python
# 🚨 修正前（間違い）
"prefix_padding_ms": 500,

# ✅ 修正後（stt_stream.py 準拠）
"prefix_padding_ms": 100,
```

**理由**: stt_stream.py では 100ms。500ms にすると発話検出が遅れ、ユーザーの最初の数語が欠落する。

#### 修正② セッション再接続ロジックの追加

stt_stream.py の再接続ロジック（`GeminiLiveApp.run` の while True ループ）をWebアプリ向けに移植する。

**stt_stream.py の再接続トリガー条件（改変禁止）:**
```python
MAX_AI_CHARS_BEFORE_RECONNECT = 800   # 累積文字数上限
LONG_SPEECH_THRESHOLD = 500           # 単発長文閾値
```

**処理順序（厳守）:**
1. `_receive()` 内で `turn_complete` 時に AI 発話文字数を累積カウント
2. 以下のいずれかで `self.needs_reconnect = True`:
   - 発話が途中で途切れた（`_is_speech_incomplete()` で判定）
   - 単発で 500文字以上
   - 累積で 800文字以上
3. `needs_reconnect` が True になったら `_session_loop()` 内で現在のセッションを閉じる
4. 会話履歴のコンテキストサマリーを生成
5. 新しい config に会話コンテキストを追加して再接続
6. `session.send_client_content(turns=..., turn_complete=True)` で「続きをお願いします」を送信
7. フロントエンドには接続断→再接続を透過的に処理（`live_ready` を再送信）

**移植元との対応表:**

| stt_stream.py | live_session.py（修正後） |
|---------------|------------------------|
| `GeminiLiveApp.run()` の while True | `_session_loop()` を while self.running ループに変更 |
| `self.ai_char_count` | `self.ai_char_count`（新規追加） |
| `self.needs_reconnect` | `self.needs_reconnect`（新規追加） |
| `self.conversation_history` | `self.conversation_history`（新規追加） |
| `self.ai_transcript_buffer` | `self.ai_transcript_buffer`（新規追加） |
| `self.user_transcript_buffer` | `self.user_transcript_buffer`（新規追加） |
| `_is_speech_incomplete()` | `_is_speech_incomplete()`（新規追加） |
| `_get_context_summary()` | `_get_context_summary()`（新規追加） |
| `_build_config(with_context=)` | `build_live_config()` にコンテキスト引数追加 |

#### 修正③ _receive() のトランスクリプトバッファリング

**現在の実装**: input_transcription/output_transcription を受信するたびに即座にフロントエンドへ送信
**stt_stream.py の実装**: バッファに蓄積し、turn_complete 時に一括処理

**方針**: 現在の即時送信方式はフロントエンドで正常に動作しているため、**バッファリングは再接続判定用にのみ追加**する。フロントエンドへの即時送信は維持。

```python
# _receive() 内の turn_complete 処理に追加（改変禁止コード）
if hasattr(sc, 'turn_complete') and sc.turn_complete:
    # --- 再接続判定（stt_stream.py 準拠） ---
    if self.ai_transcript_buffer.strip():
        ai_text = self.ai_transcript_buffer.strip()
        char_count = len(ai_text)
        self.ai_char_count += char_count

        self._add_to_history("AI", ai_text)

        is_incomplete = self._is_speech_incomplete(ai_text)
        if is_incomplete:
            self.needs_reconnect = True
        elif char_count >= 500:  # LONG_SPEECH_THRESHOLD
            self.needs_reconnect = True
        elif self.ai_char_count >= 800:  # MAX_AI_CHARS_BEFORE_RECONNECT
            self.needs_reconnect = True

        self.ai_transcript_buffer = ""

    if self.user_transcript_buffer.strip():
        self._add_to_history("ユーザー", self.user_transcript_buffer.strip())
        self.user_transcript_buffer = ""
    # --- ここまで ---

    # 既存のフロントエンド通知は維持
    self._ws_send(json.dumps({'type': 'turn_complete'}))
```

### 2-2. `app_customer_support.py` 修正箇所

**修正なし。** 現在の WebSocket エンドポイント `/ws/live/<session_id>` は正常に動作している。

🚨 **やらないこと:**
- REST API エンドポイント (`/api/chat`, `/api/session/start` 等) を削除しない
- SocketIO STT ストリーミングを削除しない
- `support_core.py` を変更しない
- `api_integrations.py` を変更しない
- `long_term_memory.py` を変更しない

### 2-3. コンシェルジュモード対応

現在の `live_websocket` エンドポイントは既に `mode` を取得してプロンプトを切り替えている。

```python
# app_customer_support.py L910 （既存コード、変更不要）
mode = session_data.get('mode', 'chat')
mode_prompts = SYSTEM_PROMPTS.get(mode, SYSTEM_PROMPTS.get('chat', {}))
system_prompt = mode_prompts.get(language, mode_prompts.get('ja', ''))
```

**確認事項**: コンシェルジュモードのプロンプト (`prompts/concierge_ja.txt`) がLiveAPI音声会話向けに適切かどうかを検証テスト時に確認。

---

## 3. フロントエンド修正仕様

### 3-1. 修正箇所

**P0修正なし。** フロントエンドは現状で正常に動作している。

具体的に確認済みの正常動作:
- `live-websocket.ts`: WebSocket接続、再接続（指数バックオフ 2s→32s, 最大5回）
- `core-controller.ts`: LiveAPI応答ハンドラー（テキスト、音声、ショップ、割り込み）
- `audio-manager.ts`: AudioWorklet→16kHz PCM→WebSocket直接送信
- `concierge-controller.ts`: コンシェルジュモード拡張

### 3-2. concierge-controller.ts の検証ポイント

コンシェルジュモードがLiveAPI経由で初期挨拶を受け取れるか確認。現在のフローは:
1. `/api/session/start` → `initial_message` をREST APIで受信
2. Cloud TTS で初期挨拶を読み上げ
3. LiveAPI WebSocket接続

**Phase1では**: この順序を維持する（LiveAPIでの初期挨拶生成はPhase2で検討）。

🚨 **やらないこと:**
- `.astro` コンポーネントファイルを変更しない
- `i18n.ts` を変更しない
- LiveWebSocket の再接続ロジックを変更しない（既に正常動作）
- AudioManager の音声処理を変更しない

---

## 4. ショップカード紹介のREST API維持

### 4-1. 設計意図

ショップカード紹介は長文（5店舗の名前・特徴を一括紹介）になるため、LiveAPIの音声出力には不向き。理由:
- LiveAPIの発話は途切れやすい（800文字上限）
- ショップ紹介はフォーマットが固定的でTTS品質が必要
- ショップカードUI表示とTTS再生のタイミング同期が重要

### 4-2. 現在のフロー（維持）

```
1. ユーザー「恵比寿でイタリアン探して」
2. Gemini LiveAPI が search_restaurants tool_call を発行
3. バックエンド:
   a. tool_call 受信
   b. 「searching」メッセージをフロントに送信
   c. Google Places / HotPepper で検索
   d. Cloud TTS でショップ紹介音声を生成
   e. 「shops」メッセージ（shops[], ttsAudio）をフロントに送信
   f. tool_response を Gemini に返す
4. フロントエンド:
   a. 「searching」受信 → ウエイティングアニメーション + 事前生成相槌再生
   b. 「shops」受信 → ショップカード表示 + Cloud TTS再生
   c. suppressNextLiveAudio = true（Geminiの後続音声を抑制）
   d. turn_complete → suppressNextLiveAudio をリセット
```

🚨 **このフローは変更しない。** tool_call後のGemini音声応答を抑制する `suppressNextLiveAudio` ロジックは正しく動作している。

---

## 5. 検証条件

### 5-1. バックエンド assert

```python
# live_session.py の設定値検証（テスト時に実行）
assert LIVE_API_MODEL == "gemini-2.5-flash-native-audio-preview-12-2025", \
    f"モデル名が改変されています: {LIVE_API_MODEL}"
assert SEND_SAMPLE_RATE == 16000, f"送信サンプルレートが改変: {SEND_SAMPLE_RATE}"
assert RECEIVE_SAMPLE_RATE == 24000, f"受信サンプルレートが改変: {RECEIVE_SAMPLE_RATE}"

config = build_live_config("test")
assert config["realtime_input_config"]["automatic_activity_detection"]["prefix_padding_ms"] == 100, \
    f"prefix_padding_ms が stt_stream.py と不一致"
assert config["realtime_input_config"]["automatic_activity_detection"]["silence_duration_ms"] == 500
assert config["context_window_compression"]["sliding_window"]["target_tokens"] == 32000
```

### 5-2. フロントエンド検証

```
□ グルメモード: 音声入力 → LiveAPI音声応答が再生される
□ グルメモード: テキスト入力 → LiveAPI音声応答が再生される
□ グルメモード: 「恵比寿でイタリアン」→ ショップカードが表示される
□ グルメモード: ショップカード表示時、Cloud TTSで紹介音声が再生される
□ グルメモード: ショップカード表示後、Geminiの遅延音声が再生されない
□ コンシェルジュモード: 初期挨拶がCloud TTSで再生される
□ コンシェルジュモード: 音声入力 → LiveAPI音声応答が再生される
□ コンシェルジュモード: レストラン検索 → ショップカード表示 + Cloud TTS
□ バックグラウンド復帰: WebSocket再接続が成功する
□ 長時間会話: 800文字超でセッション再接続が透過的に行われる
```

### 5-3. REST APIエンドポイント残存確認

```
□ GET  /health → 200
□ POST /api/session/start → session_id 返却
□ POST /api/chat → response 返却（フォールバック用）
□ POST /api/tts/synthesize → audio base64 返却
□ WS   /ws/live/<session_id> → live_ready メッセージ受信
```

---

## 6. 修正ファイル一覧

| ファイル | 修正内容 | 行数見込み |
|---------|---------|-----------|
| `support-base/live_session.py` | prefix_padding_ms修正、再接続ロジック追加、履歴追跡追加 | +120行程度 |

**変更しないファイル:**
- `support-base/app_customer_support.py`
- `support-base/support_core.py`
- `support-base/api_integrations.py`
- `support-base/long_term_memory.py`
- `src/scripts/chat/core-controller.ts`
- `src/scripts/chat/live-websocket.ts`
- `src/scripts/chat/audio-manager.ts`
- `src/scripts/chat/concierge-controller.ts`
- `src/components/*.astro`
- `src/constants/i18n.ts`

---

## 7. デプロイ手順

1. `support-base/live_session.py` の修正をコミット
2. Cloud Run にバックエンドをデプロイ（`support-base/deploy.sh`）
3. フロントエンドは変更なしのため再デプロイ不要
4. 検証条件 5-2 を全項目実施
