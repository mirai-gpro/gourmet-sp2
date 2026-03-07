# フェーズ1 設計書・仕様書: REST API → LiveAPI 移行

## 文書情報
- 作成日: 2026-03-07
- 対象リポジトリ: mirai-gpro/gourmet-sp2
- ベースコード: gourmet-support (Flask REST API) + gourmet-sp (Astro フロントエンド)

---

## 0. 前提と背景

### 0-1. 成功実証済みの技術基盤
| 項目 | 状態 | 詳細 |
|------|------|------|
| グルメモード REST API | 本番稼働中 | gourmet-support: Flask + Gemini REST API |
| コンシェルジュモード REST API | 本番稼働中 | 長期記憶(Supabase)、名前呼びかけ対応 |
| コンシェルジュ A2Eアバター・リップシンク | 実証テスト成功(70点) | audio2exp-service 連携 |
| LiveAPI (会議アシスタント) | 本番稼働中 | stt_stream.py: Gemini WebSocket双方向 |

### 0-2. フェーズ1の目標
**グルメモード・コンシェルジュモード共に、REST API → LiveAPI 化**

🚨 **例外**: ショップカード提示時のお店紹介セリフは長文のため **REST API のまま維持**

### 0-3. フェーズ2（本設計書の対象外）
A2Eアバター・リップシンクをコンシェルジュモードに追加

---

## 1. 現行アーキテクチャ（移行前）

### 1-1. バックエンド構成（gourmet-support / Flask）
```
support-base/
├── app_customer_support.py   # Flask Webアプリ層（886行）
├── support_core.py           # ビジネスロジック・コアクラス（784行）
├── api_integrations.py       # 外部API連携（752行）
├── long_term_memory.py       # Supabase長期記憶（429行）
├── requirements.txt          # Flask, google-genai, Cloud TTS/STT 等
├── Dockerfile                # Gunicorn on port 8080
└── prompts/                  # システムプロンプト(ja/en/zh/ko + concierge_ja)
```

### 1-2. 現行REST APIエンドポイント一覧
| メソッド | パス | 機能 | LiveAPI移行 |
|----------|------|------|-------------|
| POST | `/api/session/start` | セッション開始 | **維持（REST）** |
| POST | `/api/chat` | チャット送信→AI応答 | **LiveAPIに移行** |
| POST | `/api/tts/synthesize` | Cloud TTS音声合成 | **廃止**（LiveAPI音声出力に統合） |
| POST | `/api/stt/transcribe` | Cloud STT音声認識 | **廃止**（LiveAPI音声入力に統合） |
| POST | `/api/stt/stream` | Streaming STT | **廃止**（LiveAPI音声入力に統合） |
| POST | `/api/finalize` | セッション完了 | **維持（REST）** |
| POST | `/api/cancel` | 処理中止 | **維持（REST）** |
| GET | `/api/session/<id>` | セッション取得 | **維持（REST）** |
| GET | `/health` | ヘルスチェック | **維持（REST）** |
| WebSocket | Socket.IO STT | ストリーミング音声認識 | **廃止**（LiveAPI WebSocketに統合） |

### 1-3. フロントエンド構成（gourmet-sp / Astro 4）
```
src/
├── pages/          # index.astro(チャット), concierge.astro, chat.astro, 404.astro
├── components/     # GourmetChat, Concierge, ProposalCard, ShopCardList, etc.
├── scripts/chat/
│   ├── core-controller.ts      # 共通基底クラス（1040行）
│   ├── chat-controller.ts      # チャットモード（46行）
│   ├── concierge-controller.ts # コンシェルジュモード（719行）
│   └── audio-manager.ts        # AudioWorklet + VAD（733行）
├── constants/i18n.ts           # 多言語テキスト
└── styles/global.css           # Tailwind CSS
```

### 1-4. 現行通信フロー
```
[ユーザー音声] → AudioWorklet(16kHz) → Socket.IO → Flask → Google Cloud STT
                                                              ↓
[ユーザーテキスト] → fetch POST /api/chat → Flask → Gemini REST API (gemini-2.5-flash)
                                                              ↓
[AI応答テキスト] ← JSON response ← Flask ← Gemini応答
                                                              ↓
[AI音声] ← fetch POST /api/tts/synthesize → Flask → Google Cloud TTS → MP3 base64
```

---

## 2. LiveAPI 移行後アーキテクチャ

### 🚨 原則7: AIの知識が不足する領域の宣言

> **Gemini Live API (gemini-2.0-flash-live-001) は2025年後半にリリースされた新しいAPIです。**
> AIはこのAPIの正確な仕様を十分に把握していません。
> 以下の実装は、**本番稼働中の stt_stream.py の実装パターン**を正解として厳密に踏襲します。
> AIが「こうすべき」と提案しても、stt_stream.py と異なる場合は stt_stream.py を優先してください。

### 2-1. 新しい通信フロー
```
【通常会話（LiveAPI）】
[ユーザー音声] → ブラウザ WebSocket → バックエンド → Gemini LiveAPI WebSocket
                                                           ↓（双方向ストリーム）
[AI音声+テキスト] ← ブラウザ WebSocket ← バックエンド ← Gemini LiveAPI WebSocket

【ショップカード提示（REST API 維持）】
[AI応答にshopsあり] → fetch POST /api/chat → Flask → Gemini REST API
                                                        ↓
[ショップ紹介セリフ] ← 従来通り REST + Cloud TTS（長文のため）
```

### 2-2. 新バックエンド構成
```
support-base/
├── app_customer_support.py   # Flask Webアプリ層（既存REST API維持 + WebSocket追加）
├── support_core.py           # ビジネスロジック（変更なし）
├── api_integrations.py       # 外部API連携（変更なし）
├── long_term_memory.py       # 長期記憶（変更なし）
├── live_session.py           # 【新規】LiveAPI WebSocket セッション管理
├── requirements.txt          # websockets追加
├── Dockerfile                # 変更なし
└── prompts/                  # 変更なし
```

### 2-3. 新フロントエンド構成
```
src/scripts/chat/
├── core-controller.ts        # 【修正】LiveAPI WebSocket通信に変更
├── chat-controller.ts        # 【修正】LiveAPIモードのセッション初期化
├── concierge-controller.ts   # 【修正】LiveAPIモードのセッション初期化
├── audio-manager.ts          # 【修正】WebSocket直接送信に変更（Socket.IO廃止）
└── live-websocket.ts         # 【新規】LiveAPI WebSocket クライアント
```

---

## 3. バックエンド詳細設計

### 3-1. live_session.py（新規ファイル）

🚨 **改変禁止**: 以下のコードブロックは stt_stream.py の実装パターンに基づく

#### 3-1-1. LiveAPI接続パラメータ

```python
# 🚨 改変禁止: これらの値は stt_stream.py の本番稼働値と同一
LIVE_API_MODEL = "gemini-2.0-flash-live-001"
LIVE_API_CONFIG = {
    "response_modalities": ["AUDIO", "TEXT"],  # 🚨 音声+テキスト両方を受け取る
    "speech_config": {
        "voice_config": {
            "prebuilt_voice_config": {
                "voice_name": "Aoede"  # 🚨 日本語対応の音声
            }
        }
    }
}
```

#### 3-1-2. セッションライフサイクル

```
1. クライアントが WebSocket接続 → /ws/live/{session_id}
2. バックエンドが Gemini LiveAPI に WebSocket接続
3. システムプロンプトを Gemini に送信
4. クライアントからの音声チャンクを Gemini にリレー
5. Gemini からの応答（音声+テキスト）をクライアントにリレー
6. tool_call（検索等）検知時は REST API にフォールバック
```

#### 3-1-3. tool_call 処理（ショップ検索時の REST フォールバック）

🚨 **処理順序を厳守**:

```
1. Gemini LiveAPI から tool_call を受信
2. tool_call の function_name を判定
3. function_name == "search_restaurants" の場合:
   a. LiveAPI セッションを一時停止（音声ストリーム停止）
   b. 既存の support_core.py + api_integrations.py でショップ検索実行
   c. 結果を REST レスポンス形式でクライアントに送信
   d. Cloud TTS で長文の紹介セリフを音声合成（既存ロジック維持）
   e. LiveAPI セッションを再開
4. それ以外の tool_call: Gemini に結果を返して会話続行
```

### 3-2. app_customer_support.py の変更

#### 変更箇所一覧
| 行番号範囲 | 変更内容 | 影響 |
|------------|----------|------|
| 新規追加 | WebSocket エンドポイント `/ws/live/<session_id>` | LiveAPI接続 |
| 76-99行 | CORS: WebSocket用オリジン追加 | 既存に追加 |
| 既存維持 | `/api/session/start` | 変更なし |
| 既存維持 | `/api/chat` | ショップカード提示時のみ使用 |
| 既存維持 | `/api/tts/synthesize` | ショップカード紹介セリフ用に維持 |
| 廃止対象 | Socket.IO STT 関連（740-880行） | LiveAPIに統合 |

#### 🚨 やらないこと
- support_core.py の SupportSession / SupportAssistant クラスの構造変更
- api_integrations.py の外部API連携ロジックの変更
- long_term_memory.py の変更
- プロンプトファイルの変更
- 既存REST APIエンドポイントの削除（ショップカード用に維持）

### 3-3. 環境変数

```bash
# 🚨 具体値を書く（参照で逃げない）

# 既存（変更なし）
GEMINI_API_KEY=<既存のキーを使用>
GOOGLE_APPLICATION_CREDENTIALS=<既存のサービスアカウントJSONパス>
GOOGLE_PLACES_API_KEY=<既存のキーを使用>
HOTPEPPER_API_KEY=<既存のキーを使用>

# LiveAPI用（新規）
# 🚨 LiveAPIのモデル名は固定: gemini-2.0-flash-live-001
# 🚨 GeminiのAPIキーは既存の GEMINI_API_KEY を共用
```

---

## 4. フロントエンド詳細設計

### 4-1. live-websocket.ts（新規ファイル）

#### 4-1-1. WebSocket接続仕様

```typescript
// 🚨 改変禁止: WebSocket URL形式
const WS_URL = `wss://${API_HOST}/ws/live/${sessionId}`;

// 🚨 改変禁止: メッセージ形式（バックエンドとの契約）
interface LiveMessage {
  type: 'audio' | 'text' | 'tool_result' | 'shops' | 'error' | 'session_end';
  data: any;
}

// クライアント → サーバー
interface ClientMessage {
  type: 'audio_chunk' | 'text_input' | 'cancel';
  data: any;  // audio_chunk: base64文字列, text_input: 文字列
}
```

#### 4-1-2. 音声データ形式

```typescript
// 🚨 具体値を書く
// クライアント → サーバー: PCM 16bit, 16kHz, mono
// サーバー → クライアント: PCM 16bit, 24kHz, mono（Gemini LiveAPIのデフォルト出力）
const INPUT_SAMPLE_RATE = 16000;   // 🚨 固定値
const OUTPUT_SAMPLE_RATE = 24000;  // 🚨 Gemini LiveAPI出力のデフォルト
```

### 4-2. core-controller.ts の変更

#### 変更箇所一覧
| メソッド | 変更内容 |
|----------|----------|
| `initSocket()` | Socket.IO → LiveAPI WebSocket に変更 |
| `sendMessage()` | REST `/api/chat` → WebSocket送信に変更。ただしショップカード提示時は REST 維持 |
| `speakTextGCP()` | LiveAPIからの音声ストリームを直接再生。ショップカード紹介時のみ Cloud TTS 維持 |
| `toggleRecording()` | AudioWorklet → WebSocket直接送信に変更 |
| `handleStreamingSTTComplete()` | 廃止（LiveAPIがSTT+LLM+TTSを一括処理） |

#### 🚨 やらないこと
- i18n.ts の変更
- Astroコンポーネント（.astro）の変更
- UIデザイン・レイアウトの変更
- ShopCardList / ProposalCard の変更
- InstallPrompt / ReservationModal の変更
- PWA設定の変更

### 4-3. audio-manager.ts の変更

#### 変更方針
- Socket.IO経由の音声送信 → WebSocket直接送信に変更
- AudioWorkletの16kHzダウンサンプリングは**そのまま維持**
- VAD（無音検知）ロジックは**そのまま維持**（LiveAPIのVADと併用）

```typescript
// 🚨 改変禁止: AudioWorkletの音声処理パラメータ
const TARGET_SAMPLE_RATE = 16000;  // ダウンサンプリング後のサンプルレート
const BUFFER_SIZE = 8192;          // iOS用バッファサイズ（既存値維持）
// PC/Android用は16000（既存値維持）
```

---

## 5. 移植元との対応表（原則6）

### 5-1. バックエンド
| 移植元（stt_stream.py） | 移植先（live_session.py） | 備考 |
|--------------------------|---------------------------|------|
| Gemini LiveAPI接続初期化 | `LiveSession.__init__()` | モデル名・設定値を完全コピー |
| 音声チャンク受信→Gemini送信 | `LiveSession.send_audio()` | base64 → バイナリ変換 |
| Gemini応答受信→クライアント送信 | `LiveSession.on_response()` | テキスト+音声の分離処理 |
| セッション終了処理 | `LiveSession.close()` | WebSocket切断 |

### 5-2. フロントエンド
| 移植元（現行） | 移植先（LiveAPI版） | 備考 |
|----------------|---------------------|------|
| Socket.IO接続 (core-controller.ts:234-260) | WebSocket接続 (live-websocket.ts) | Socket.IO → ネイティブWebSocket |
| AudioWorklet→Socket.IO (audio-manager.ts) | AudioWorklet→WebSocket | 音声処理は変更なし、送信先のみ変更 |
| REST /api/chat (core-controller.ts:559) | WebSocket送信 | テキスト入力時 |
| REST /api/tts/synthesize (core-controller.ts:764) | WebSocket音声受信 | ショップカード時のみREST維持 |

---

## 6. 検証条件（原則8: assertで書く）

### 6-1. バックエンド検証

```python
# assert 1: LiveAPIモデル名が正しいこと
assert LIVE_API_MODEL == "gemini-2.0-flash-live-001", "モデル名が改変されています"

# assert 2: response_modalitiesにAUDIOとTEXTが含まれること
assert "AUDIO" in LIVE_API_CONFIG["response_modalities"]
assert "TEXT" in LIVE_API_CONFIG["response_modalities"]

# assert 3: 既存REST APIエンドポイントが全て残っていること
# /api/session/start, /api/chat, /api/tts/synthesize, /api/finalize, /api/cancel, /health
assert app.url_map.has('/api/session/start')
assert app.url_map.has('/api/chat')
assert app.url_map.has('/api/tts/synthesize')

# assert 4: support_core.py が変更されていないこと
# git diff support-base/support_core.py で差分が0であること

# assert 5: api_integrations.py が変更されていないこと
# git diff support-base/api_integrations.py で差分が0であること
```

### 6-2. フロントエンド検証

```typescript
// assert 1: 音声入力のサンプルレートが16kHzであること
console.assert(TARGET_SAMPLE_RATE === 16000, "入力サンプルレートが改変されています");

// assert 2: LiveAPI音声出力が24kHzであること
console.assert(OUTPUT_SAMPLE_RATE === 24000, "出力サンプルレートが改変されています");

// assert 3: ショップカード表示時にREST APIが使われること
// data.shops.length > 0 の場合、fetch('/api/chat') が呼ばれること

// assert 4: i18n.ts が変更されていないこと
// git diff src/constants/i18n.ts で差分が0であること
```

---

## 7. 実装順序（原則3: 番号付きで厳守）

### ステップ1: バックエンド LiveAPI基盤
1. `live_session.py` 新規作成（stt_stream.py をベースに）
2. `app_customer_support.py` に WebSocket エンドポイント追加
3. 既存REST APIエンドポイントは一切変更しない
4. requirements.txt に `websockets` 追加

### ステップ2: フロントエンド WebSocket基盤
5. `live-websocket.ts` 新規作成
6. `core-controller.ts` の通信部分をLiveAPI対応に変更
7. `audio-manager.ts` の送信先をWebSocketに変更

### ステップ3: ショップカード REST フォールバック
8. LiveAPIセッション中のtool_call検知 → REST API呼び出し
9. ショップカード表示 + Cloud TTS長文読み上げ（既存ロジック維持）

### ステップ4: 結合テスト
10. グルメモード: テキスト入力 → LiveAPI → 音声応答
11. グルメモード: 音声入力 → LiveAPI → 音声応答
12. グルメモード: ショップ検索 → REST フォールバック → ショップカード表示
13. コンシェルジュモード: 長期記憶 + LiveAPI
14. 4言語テスト（ja, en, zh, ko）

---

## 8. リスクと注意事項

### 🚨 変えがちな箇所を明示（原則4）

| 箇所 | リスク | 対策 |
|------|--------|------|
| LiveAPIモデル名 | AIが `gemini-2.5-flash` に変更しがち | assert で検証 |
| 音声サンプルレート | AIが 48kHz に変更しがち | 入力16kHz/出力24kHz を assert で検証 |
| REST API削除 | AIが「不要」と判断して削除しがち | ショップカード用に必須。削除禁止 |
| support_core.py 改変 | AIが「改善」しようとしがち | diff が0であることを検証 |
| Socket.IO 残存 | AIが Socket.IO を残しがち | LiveAPI WebSocket に完全移行 |
| Cloud TTS 全廃 | AIがショップカード用も廃止しがち | ショップカード紹介は REST+TTS 維持 |

### やらないこと（原則5）
1. Astroコンポーネント（.astro ファイル）の変更
2. CSSスタイルの変更
3. i18n.ts の変更
4. PWA設定の変更
5. Vercel設定の変更
6. support_core.py の変更
7. api_integrations.py の変更
8. long_term_memory.py の変更
9. プロンプトファイルの変更
10. Supabase関連の変更
11. Audio2Expression（A2E）の統合（フェーズ2）
