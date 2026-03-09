# -*- coding: utf-8 -*-
"""
LiveAPI WebSocket セッション管理

stt_stream.py の実装パターンを厳密に踏襲。
差異がある場合は stt_stream.py を正とする。

stt_stream.py からの移植対応表:
  - pyaudio入出力 → ブラウザWebSocketリレー
  - ローカル実行 → Flask バックグラウンドスレッド
  - 会議アシスタント用ツール → search_restaurants ツール
  - REST API (gemini-2.5-flash) → 既存 support_core.py に委譲
"""
import asyncio
import base64
import json
import logging
import os
import threading
import concurrent.futures

from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

# ============================================================
# 設定（stt_stream.py 準拠）
# ============================================================
LIVE_API_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"
REST_API_MODEL = "gemini-2.5-flash"
SEND_SAMPLE_RATE = 16000
RECEIVE_SAMPLE_RATE = 24000

# ============================================================
# search_restaurants ツール定義
# ============================================================
SEARCH_TOOL = {
    "function_declarations": [
        {
            "name": "search_restaurants",
            "description": (
                "ユーザーの要望に基づいてレストランを検索します。"
                "エリアや料理ジャンル、雰囲気、予算などの条件でお店を探します。"
                "ユーザーがお店を探していると判断した場合にこのツールを呼び出してください。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "検索クエリ（例: '恵比寿で美味しいイタリアン'）"
                    },
                    "area": {
                        "type": "string",
                        "description": "エリア・地名（例: 恵比寿、渋谷、新宿）"
                    }
                },
                "required": ["query"]
            }
        }
    ]
}

# ============================================================
# update_user_profile ツール定義（コンシェルジュモード用）
# ============================================================
UPDATE_PROFILE_TOOL = {
    "function_declarations": [
        {
            "name": "update_user_profile",
            "description": (
                "ユーザーが名前や呼び方を教えてくれた場合に呼び出します。"
                "初回訪問で名前を聞いた時や、呼び方の変更を依頼された時に使用します。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "preferred_name": {
                        "type": "string",
                        "description": "ユーザーの呼び名（例: 太郎、山田）"
                    },
                    "name_honorific": {
                        "type": "string",
                        "description": "敬称（例: 様、さん、くん）。指定がなければ「様」"
                    }
                },
                "required": ["preferred_name"]
            }
        }
    ]
}

# ============================================================
# LiveAPI 用プロンプト補足
# 基本プロンプト（support_system_ja.txt / concierge_ja.txt）の
# JSON出力指示を全て上書きする。
# ============================================================
LIVE_API_PROMPT_SUPPLEMENT = """

## 【最重要】応答の簡潔さルール

- **1回の発話は50文字以内を目標にする**（検索結果紹介を除く）
- **1ターンで聞く質問は最大2つまで**。3つ以上を同時に聞かない
- ヒアリング項目が複数残っていても、1〜2個ずつ段階的に聞く
- 余計な前置き・繰り返し・丁寧すぎる表現は省く

### 簡潔な応答例
- ✕「ありがとうございます！それでは、どのエリアでお探しでしょうか？また、女子会や会食など、どのような目的でのご利用ですか？」
- ○「どのエリアで、どんな目的ですか？」

- ✕「ありがとうございます。料理のジャンルや、落ち着いた雰囲気・賑やかな雰囲気などのご希望はありますか？また、何名様でのご利用でしょうか？」
- ○「ジャンルの希望はありますか？」

- ✕「ご予算はいかがでしょうか？コースでお考えか、アラカルトで注文して合計で一人当たり、いくらくらいか？、など目安があれば教えてください。」
- ○「予算はどのくらいですか？」

---
## 【最優先】LiveAPI 音声会話モード — 以下のルールが上記の全指示に優先します

### 出力形式の上書き（重要）

上記プロンプト内の以下の指示は **すべて無効** です。従わないでください：
- 「JSON形式のみで応答」「JSON形式で出力」に関する全ての指示
- 「message」「shops」フィールドの構造定義
- 「action」フィールドによるプロファイル更新の指示
- JSON応答例・出力チェックリスト内のJSON関連項目

### あなたの応答形式

あなたは **音声で直接ユーザーと会話** しています。
- 全ての応答は **自然な話し言葉** で行ってください
- JSON、マークダウン、構造化テキストは一切出力しないでください
- 1回の発話は簡潔に（長文は避ける）

### レストラン検索時の応答フロー（絶対に守ること・違反禁止）

⚠️ **search_restaurants を呼ぶ前に、必ず音声で復唱すること。復唱なしのツール呼び出しは禁止。**

1. **復唱+お待ち（絶対必須・省略禁止）**: まずユーザーのリクエストを短く復唱して声に出す
   - 例: 「恵比寿で焼き鳥ですね、お探しします！」
   - 例: 「渋谷のイタリアンですね、少々お待ちください。」
   - 例: 「かしこまりました。新宿で和食ですね、お調べします。」
   - **この1文を必ず発話してから**次のステップへ進むこと

2. **ツール呼び出し**: 復唱を話し終えた後に search_restaurants を呼び出す
   - ⚠️ 復唱せずにいきなりツールを呼ぶのは絶対禁止

3. **検索結果の紹介**: ツール結果を受け取った後、簡潔に紹介する
   - 例: 「見つかりました。画面のカードをご覧ください。」
   - ※詳しい説明は別途システムが読み上げるので、ここでは短くまとめる

### 応答スタイル
- 親しみやすく簡潔なコンシェルジュ口調
- 1回の発話は短く（長文は避ける）
- 「えーっと」「そうですね」など自然なフィラーは適度に使ってOK
- 金額を言う場合は漢数字で（「五千円」「一万二千円」）

### 上記プロンプトから引き続き有効な指示

以下のドメイン知識・行動ルールは **そのまま有効** です：
- ヒアリングの順序（場所→目的→ジャンル→予算→日程）
- 雰囲気条件の厳守ルール
- 実在店舗のみ提案するルール
- 短期記憶・重複質問禁止ルール
- 業態別ヒアリング制御ルール
- 長期記憶サマリールール
- 音声読み上げ最適化（誤読防止）
- AI電話予約機能の案内タイミング

---

### レストラン検索の仕組み（重要）

ショップカードの作成・お店の詳細情報は **バックエンドが自動処理** します。
あなたが JSON や shops 配列を生成する必要はありません。

※ ショップカードの表示・お店の説明音声はシステムが自動生成します。
※ あなたは結果の件数と簡単な案内だけを話してください。

### 深掘り質問への対応

ユーザーが表示済みのお店について質問した場合:
- 音声で自然に回答してください
- 質問例: 「個室はある？」「予算は？」「ワインは充実してる？」
- 知っている情報を元に回答し、不明な点は正直に伝えてください

### 日時ワード検出時のAI電話予約案内

ユーザーの発話に日時（明日、今週末、◯時など）が含まれる場合:
- お店の紹介後に、AI電話予約機能を自然に案内してください
- 例: 「明日のランチでしたら、私が直接お店に電話して予約確認もできますよ。」
- 「予約依頼画面」というワードを含めてください
"""

# コンシェルジュモード専用の追加プロンプト
LIVE_API_CONCIERGE_SUPPLEMENT = """

### 初回挨拶について

接続が確立したら、あなたから最初に挨拶してください。
{greeting_instruction}

### 名前の登録・変更

ユーザーが名前を教えてくれたら update_user_profile ツールを呼び出してください。
- 呼び名（preferred_name）と敬称（name_honorific）を設定します
- 敬称の指定がなければデフォルトで「様」を使います
- ユーザーが名前を教えたくない場合は、名前なしで会話を続けてください
"""

# グルメ（チャット）モード専用の追加プロンプト
LIVE_API_CHAT_SUPPLEMENT = """

### 初回挨拶について

接続が確立したら、あなたから最初に挨拶してください。
「こんにちは！お店探しをお手伝いします。どのようなお店をお探しですか？」
のように、簡潔に挨拶してすぐにヒアリングに入ってください。
"""

# Cloud TTS 音声マッピング（ショップカード紹介用、REST フォールバック時に使用）
VOICE_MAP = {
    'ja': ('ja-JP', 'ja-JP-Chirp3-HD-Leda'),
    'en': ('en-US', 'en-US-Studio-O'),
    'zh': ('cmn-CN', 'cmn-CN-Wavenet-A'),
    'ko': ('ko-KR', 'ko-KR-Wavenet-A')
}


def build_live_config(system_prompt, mode='chat'):
    """
    Live API 設定を構築（stt_stream.py _build_config 準拠）

    stt_stream.py との差異:
      - voice_name: "Aoede" を追加（グルメアプリ用の声）
      - tools: search_restaurants（全モード）+ update_user_profile（コンシェルジュのみ）
      - automatic_activity_detection: HIGH感度（自動VADでターン検知）
      - prefix_padding_ms: 100（stt_stream.py 準拠）
    """
    # モード別ツール構成
    tools = [SEARCH_TOOL]
    if mode == 'concierge':
        tools.append(UPDATE_PROFILE_TOOL)

    return {
        "response_modalities": ["AUDIO"],
        "system_instruction": system_prompt,
        "output_audio_transcription": {},
        "speech_config": {
            "language_code": "ja-JP",
            "voice_config": {
                "prebuilt_voice_config": {
                    "voice_name": "Aoede"
                }
            },
        },
        "realtime_input_config": {
            "automatic_activity_detection": {
                "disabled": False,
                "start_of_speech_sensitivity": "START_SENSITIVITY_HIGH",
                "end_of_speech_sensitivity": "END_SENSITIVITY_HIGH",
                "prefix_padding_ms": 300,
                "silence_duration_ms": 100,
            }
        },
        "context_window_compression": {
            "sliding_window": {
                "target_tokens": 32000,
            }
        },
        "tools": tools,
    }


class LiveSession:
    """
    単一の Gemini LiveAPI セッション
    ブラウザ WebSocket ↔ バックエンド ↔ Gemini LiveAPI WebSocket の双方向リレー

    stt_stream.py GeminiLiveApp との対応:
      - _session_loop  → GeminiLiveApp.run + _session_loop
      - _send_audio    → send_audio (listen_audio → send_audio)
      - _receive       → receive_audio
      - _handle_tool_call → _handle_tool_call
    """

    # セッション再接続の閾値（stt_stream.py 準拠）
    MAX_AI_CHARS_BEFORE_RECONNECT = 800
    LONG_SPEECH_THRESHOLD = 500

    def __init__(self, session_id, system_prompt, ws, language='ja', mode='chat',
                 user_context=''):
        self.session_id = session_id
        # モード別プロンプト構築: 基本プロンプト + LiveAPI共通補足 + モード別補足
        self.system_prompt = system_prompt + LIVE_API_PROMPT_SUPPLEMENT
        if mode == 'concierge':
            self.system_prompt += LIVE_API_CONCIERGE_SUPPLEMENT.format(
                greeting_instruction=user_context or '初めてのユーザーです。自然に挨拶して、名前を聞いてください。'
            )
        else:
            self.system_prompt += LIVE_API_CHAT_SUPPLEMENT
        self.ws = ws
        self.language = language
        self.mode = mode

        self.loop = None
        self.gemini_session = None
        self.audio_queue = None  # ブラウザ → Gemini への音声キュー
        self.running = False
        self.thread = None
        self._ws_lock = threading.Lock()

        # セッション再接続用（stt_stream.py 準拠）
        self.ai_char_count = 0
        self.needs_reconnect = False
        self.session_count = 0
        self.conversation_history = []
        self.ai_transcript_buffer = ""

    def start(self):
        """バックグラウンドスレッドで LiveAPI セッションを開始"""
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _ws_send(self, data):
        """スレッドセーフなブラウザ WebSocket 送信"""
        with self._ws_lock:
            try:
                self.ws.send(data)
            except Exception as e:
                logger.error(f"[LiveSession] WS send error: {e}")

    def _run(self):
        """asyncio event loop（stt_stream.py の asyncio.run 相当）"""
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_until_complete(self._session_loop())
        except Exception as e:
            logger.error(f"[LiveSession] Session error: {e}")
            self._ws_send(json.dumps({'type': 'error', 'data': str(e)}))
        finally:
            self.loop.close()

    def _add_to_history(self, role, text):
        """会話履歴に追加（stt_stream.py 準拠: 直近20ターン保持）"""
        self.conversation_history.append({"role": role, "text": text})
        if len(self.conversation_history) > 20:
            self.conversation_history = self.conversation_history[-20:]

    def _get_context_summary(self):
        """会話履歴の要約を取得（stt_stream.py 準拠）"""
        if not self.conversation_history:
            return ""

        recent = self.conversation_history[-10:]
        summary_parts = []
        for h in recent:
            text = h['text'][:150]
            summary_parts.append(f"{h['role']}: {text}")

        summary = "\n".join(summary_parts)

        # 最後のAI発言が質問なら強調
        last_ai = None
        for h in reversed(self.conversation_history):
            if h['role'] == 'AI':
                last_ai = h['text']
                break

        if last_ai and any(q in last_ai for q in ['?', '？', 'か?', 'か？']):
            summary += f"\n\n【直前の質問（これに対する回答を待っています）】\n{last_ai[:200]}"

        return summary

    async def _session_loop(self):
        """
        Gemini LiveAPI メインセッションループ（再接続対応）
        stt_stream.py GeminiLiveApp.run → _session_loop 準拠
        """
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY が設定されていません")

        client = genai.Client(api_key=api_key)

        while self.running:
            self.session_count += 1
            self.ai_char_count = 0
            self.needs_reconnect = False

            # 再接続時はコンテキストを引き継ぐ
            context = None
            if self.session_count > 1:
                context = self._get_context_summary()
                logger.info(f"[LiveSession] Reconnecting (#{self.session_count}): session={self.session_id}")
                if context:
                    logger.info(f"[LiveSession] Context: {context[:80]}...")

            config = build_live_config(self.system_prompt, self.mode)

            # 再接続時はコンテキストをシステムプロンプトに追加
            if context:
                config["system_instruction"] = (
                    self.system_prompt +
                    f"\n\n## 【会話の継続】\n以下は直前の会話履歴です。自然に会話を続けてください。\n{context}"
                )

            logger.info(f"[LiveSession] Connecting (#{self.session_count}): model={LIVE_API_MODEL}, session={self.session_id}")

            try:
                async with client.aio.live.connect(
                    model=LIVE_API_MODEL,
                    config=config
                ) as session:
                    self.gemini_session = session
                    self.audio_queue = asyncio.Queue(maxsize=5)

                    if self.session_count == 1:
                        self._ws_send(json.dumps({'type': 'live_ready'}))
                        logger.info(f"[LiveSession] Connected (#{self.session_count}): session={self.session_id}")
                    else:
                        # stt_stream.py 準拠: 再接続時のみテキストで応答を促す
                        logger.info(f"[LiveSession] Reconnected (#{self.session_count}): session={self.session_id}")
                        try:
                            await session.send_client_content(
                                turns=types.Content(
                                    role="user",
                                    parts=[types.Part(text="続きをお願いします")]
                                ),
                                turn_complete=True
                            )
                            logger.info(f"[LiveSession] Reconnect trigger sent")
                        except Exception as e:
                            logger.warning(f"[LiveSession] Reconnect trigger error: {e}")

                    try:
                        await asyncio.gather(
                            self._send_audio(session),
                            self._receive(session)
                        )
                    except Exception as e:
                        if self.running:
                            logger.error(f"[LiveSession] Loop error: {e}")

                    # needs_reconnect が True なら再接続
                    if not self.needs_reconnect:
                        break

            except Exception as e:
                error_msg = str(e).lower()
                logger.error(f"[LiveSession] Session error (#{self.session_count}): {e}")

                if any(kw in error_msg for kw in ["1011", "internal error", "disconnected", "closed", "websocket"]):
                    logger.info("[LiveSession] Reconnectable error. Retrying in 3s...")
                    self.needs_reconnect = True
                    await asyncio.sleep(3)
                    continue
                else:
                    self._ws_send(json.dumps({'type': 'error', 'data': str(e)}))
                    break

    async def _send_audio(self, session):
        """
        キューから音声を取得して Gemini に送信
        stt_stream.py send_audio 準拠: session.send_realtime_input(audio=msg)
        """
        while self.running and not self.needs_reconnect:
            try:
                msg = await asyncio.wait_for(self.audio_queue.get(), timeout=0.1)
                if msg is None:
                    break
                await session.send_realtime_input(audio=msg)
            except asyncio.TimeoutError:
                continue
            except Exception as e:
                if self.running:
                    logger.error(f"[LiveSession] Send error: {e}")

    async def _receive(self, session):
        """
        Gemini からの応答を受信してブラウザにリレー
        stt_stream.py receive_audio 準拠（累積文字数管理付き）
        """
        try:
            while self.running and not self.needs_reconnect:
                turn = session.receive()
                async for response in turn:
                    if not self.running:
                        return

                    # ツールコール（stt_stream.py: tool_call イベント検知）
                    if hasattr(response, 'tool_call') and response.tool_call:
                        await self._handle_tool_call(session, response.tool_call)
                        continue

                    if not response.server_content:
                        continue

                    sc = response.server_content

                    # ターン完了（stt_stream.py: turn_complete）
                    if hasattr(sc, 'turn_complete') and sc.turn_complete:
                        # AI発話の累積文字数チェック（stt_stream.py 準拠）
                        if self.ai_transcript_buffer:
                            ai_text = self.ai_transcript_buffer.strip()
                            char_count = len(ai_text)
                            self.ai_char_count += char_count
                            remaining = self.MAX_AI_CHARS_BEFORE_RECONNECT - self.ai_char_count
                            logger.info(f"[LiveSession] AI turn: {char_count}chars (total: {self.ai_char_count}, remaining: {remaining})")

                            self._add_to_history('AI', ai_text)
                            self.ai_transcript_buffer = ""

                            # 長い発話 → 次で途切れるリスクが高い
                            if char_count >= self.LONG_SPEECH_THRESHOLD:
                                logger.info(f"[LiveSession] Long speech ({char_count} chars). Reconnecting.")
                                self.needs_reconnect = True
                            # 累積上限に近づいた
                            elif self.ai_char_count >= self.MAX_AI_CHARS_BEFORE_RECONNECT:
                                logger.info(f"[LiveSession] Char limit reached ({self.ai_char_count}). Reconnecting.")
                                self.needs_reconnect = True

                        self._ws_send(json.dumps({'type': 'turn_complete'}))

                        if self.needs_reconnect:
                            return  # ループを抜けて再接続

                    # 割り込み検知（stt_stream.py: interrupted）
                    if hasattr(sc, 'interrupted') and sc.interrupted:
                        self._ws_send(json.dumps({'type': 'interrupted'}))
                        continue

                    # 出力トランスクリプション（stt_stream.py: output_transcription）
                    if hasattr(sc, 'output_transcription') and sc.output_transcription:
                        text = sc.output_transcription.text
                        if text:
                            self.ai_transcript_buffer += text
                            self._ws_send(json.dumps({
                                'type': 'text',
                                'data': text
                            }))

                    # 音声データ（stt_stream.py: model_turn.parts[].inline_data）
                    if sc.model_turn:
                        for part in sc.model_turn.parts:
                            if hasattr(part, 'inline_data') and part.inline_data:
                                if isinstance(part.inline_data.data, bytes):
                                    audio_b64 = base64.b64encode(
                                        part.inline_data.data
                                    ).decode('utf-8')
                                    self._ws_send(json.dumps({
                                        'type': 'audio',
                                        'data': audio_b64
                                    }))

        except Exception as e:
            if self.running:
                error_msg = str(e).lower()
                logger.error(f"[LiveSession] Receive error: {e}")
                # 切断エラーは再接続で対応
                if any(kw in error_msg for kw in ["1011", "internal error", "disconnected", "closed"]):
                    self.needs_reconnect = True
                else:
                    self._ws_send(json.dumps({'type': 'error', 'data': str(e)}))

    async def _handle_tool_call(self, session, tool_call):
        """
        ツールコール処理
        stt_stream.py _handle_tool_call 準拠

        処理順序（仕様書 Section 3-1-3）:
        1. tool_call 受信
        2. function_name 判定
        3. search_restaurants → 既存コードでショップ検索 → 結果をフロントエンドに送信
        4. ツール結果を Gemini に返す（session.send_tool_response）
        """
        for fc in tool_call.function_calls:
            logger.info(f"[LiveSession] Tool call: {fc.name}, args={fc.args}")

            if fc.name == "search_restaurants":
                query = fc.args.get("query", "") if fc.args else ""
                area = fc.args.get("area", "") if fc.args else ""

                # ウエイティングアニメーション開始をフロントに通知
                self._ws_send(json.dumps({'type': 'searching'}))

                result = await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda q=query, a=area: self._execute_restaurant_search(q, a)
                )

                shops = result.get('shops', [])
                logger.info(f"[LiveSession] Shop search: {len(shops)} shops found")

                # ツール結果を Gemini に返す（stt_stream.py: session.send_tool_response）
                try:
                    shop_names = [s.get('name', '') for s in shops]
                    await session.send_tool_response(
                        function_responses=[
                            types.FunctionResponse(
                                name=fc.name,
                                id=fc.id,
                                response={
                                    "result": f"{len(shops)}件のレストランが見つかりました",
                                    "shops": shop_names
                                }
                            )
                        ]
                    )
                except Exception as e:
                    logger.error(f"[LiveSession] Tool response error: {e}")
            elif fc.name == "update_user_profile":
                await self._handle_update_profile(session, fc)

            else:
                logger.warning(f"[LiveSession] Unknown tool: {fc.name}")

    async def _handle_update_profile(self, session, fc):
        """
        ユーザープロファイル更新ツール処理（コンシェルジュモード用）
        既存のREST APIと同じ LongTermMemory.update_profile() を使用する。
        """
        preferred_name = fc.args.get("preferred_name", "") if fc.args else ""
        name_honorific = fc.args.get("name_honorific", "様") if fc.args else "様"

        logger.info(f"[LiveSession] Profile update: name={preferred_name}, honorific={name_honorific}")

        result_msg = "プロファイル更新失敗"
        try:
            from support_core import SupportSession
            support_session = SupportSession(self.session_id)
            session_data = support_session.get_data()
            user_id = session_data.get('user_id') if session_data else None

            if user_id:
                from long_term_memory import LongTermMemory
                ltm = LongTermMemory()
                updates = {
                    'preferred_name': preferred_name,
                    'name_honorific': name_honorific
                }
                success = ltm.update_profile(user_id, updates)
                if success:
                    # RAMセッションのプロファイルも更新
                    if session_data:
                        profile = session_data.get('long_term_profile') or {}
                        profile.update(updates)
                        session_data['long_term_profile'] = profile
                        session_data['is_first_visit'] = False

                    result_msg = f"{preferred_name}{name_honorific}として登録しました"
                    logger.info(f"[LiveSession] Profile updated: {preferred_name}{name_honorific}")
                else:
                    logger.error(f"[LiveSession] Profile update failed for user_id={user_id}")
            else:
                logger.warning(f"[LiveSession] No user_id, skipping profile update")

            # フロントエンドにも通知
            self._ws_send(json.dumps({
                'type': 'profile_updated',
                'data': {
                    'preferred_name': preferred_name,
                    'name_honorific': name_honorific
                }
            }))
        except Exception as e:
            logger.error(f"[LiveSession] Profile update error: {e}")

        # ツール結果を Gemini に返す
        try:
            await session.send_tool_response(
                function_responses=[
                    types.FunctionResponse(
                        name=fc.name,
                        id=fc.id,
                        response={"result": result_msg}
                    )
                ]
            )
        except Exception as e:
            logger.error(f"[LiveSession] Tool response error: {e}")

    def _execute_restaurant_search(self, query, area):
        """
        Google Places で実在店舗を検索 → enrichment + REST API で詳細説明生成

        1軒目先行送信（gourmet-support 移植）:
          1. Google Places 検索
          2. 1軒目の説明+TTS を先行生成 → フロントに即送信（shops メッセージ）
          3. 残り全軒の enrichment + 説明生成を並行実行
          4. 全軒完了 → フロントに差し替え送信（shops_update メッセージ）
        """
        try:
            from api_integrations import (
                search_google_restaurants, enrich_shops_with_photos,
                extract_area_from_text, get_region_from_area
            )

            language = self.language

            if not area:
                area = extract_area_from_text(query, language)

            geo_info = get_region_from_area(area, language) if area else None

            # Google Places Text Search で実在店舗を検索（ハルシネーション・廃業対策）
            shops = search_google_restaurants(query, area, geo_info, language, count=5)

            if not shops:
                logger.info(f"[LiveSession] Google Places: 0件 query='{query}' area='{area}'")
                return {'shops': [], 'response': '', 'tts_audio': ''}

            # 説明生成用に基本情報を先行抽出（enrichment による変更前）
            shop_basics = [
                {'name': s.get('name', ''), 'area': s.get('area', '')}
                for s in shops
            ]

            # ====================================================
            # Step 1: 1軒目の説明を先行生成 → 即送信
            # ====================================================
            first_desc = self._generate_shop_descriptions(
                shop_basics[:1], query, language
            )
            first_response = ''
            if first_desc:
                first_response = first_desc.get('message', '')
                # 1軒目に説明データをマージ
                desc_list = first_desc.get('descriptions', [])
                if desc_list and isinstance(desc_list[0], dict):
                    for key in ['description', 'highlights', 'tips',
                                'specialty', 'atmosphere', 'features']:
                        if desc_list[0].get(key):
                            shops[0][key] = desc_list[0][key]

            if not first_response:
                first_response = self._build_shop_intro_text(shops[:1], language)

            # 1軒目のTTS生成
            first_tts = self._generate_tts(first_response, language) if first_response else ''

            # 1軒目を先行送信（ショップカード表示+TTS再生開始）
            self._ws_send(json.dumps({
                'type': 'shops',
                'data': {
                    'response': first_response,
                    'shops': [shops[0]],
                    'ttsAudio': first_tts
                }
            }))
            logger.info(f"[LiveSession] First shop sent: {shops[0].get('name', '')}")

            # ====================================================
            # Step 2: 残り全軒の enrichment + 説明生成を並行実行
            # ====================================================
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                enrich_future = executor.submit(
                    enrich_shops_with_photos, shops, area, language
                )
                desc_future = executor.submit(
                    self._generate_shop_descriptions, shop_basics, query, language
                )

                # 全軒の説明取得
                descriptions = desc_future.result()
                # enrichment 完了を待つ
                enriched_shops = enrich_future.result() or shops

            # 全軒の説明データを enriched shops にマージ
            if descriptions:
                desc_list = descriptions.get('descriptions', [])
                for shop, desc in zip(enriched_shops, desc_list):
                    if not isinstance(desc, dict):
                        continue
                    for key in ['description', 'highlights', 'tips',
                                'specialty', 'atmosphere', 'features']:
                        if desc.get(key):
                            shop[key] = desc[key]

            # 全軒の完全データを差し替え送信
            full_response = ''
            if descriptions:
                full_response = descriptions.get('message', '')
            if not full_response:
                full_response = self._build_shop_intro_text(enriched_shops, language)

            self._ws_send(json.dumps({
                'type': 'shops_update',
                'data': {
                    'response': full_response,
                    'shops': enriched_shops
                }
            }))

            logger.info(f"[LiveSession] Search complete: {len(enriched_shops)} shops")

            return {'shops': enriched_shops, 'response': full_response, 'tts_audio': ''}

        except Exception as e:
            logger.error(f"[LiveSession] Restaurant search error: {e}")
            return {'shops': [], 'response': '', 'tts_audio': ''}

    def _generate_shop_descriptions(self, shop_basics, user_query, language):
        """
        Gemini REST API で各店舗の詳細説明を生成

        shop_basics: [{'name': '...', 'area': '...'}, ...]
        Returns: {'message': '...', 'descriptions': [...]} or None
        """
        try:
            api_key = os.environ.get("GEMINI_API_KEY")
            if not api_key:
                return None

            client = genai.Client(api_key=api_key)

            shop_info = []
            for i, s in enumerate(shop_basics, 1):
                shop_info.append(f"{i}. {s['name']} ({s['area']})")

            shop_count = len(shop_basics)
            shop_list_str = '\n'.join(shop_info)

            if language == 'ja':
                prompt = f"""以下のレストラン検索結果について、各店舗の紹介文を生成してください。

ユーザーのリクエスト: {user_query}

検索結果:
{shop_list_str}

以下のJSON形式で出力してください:
{{
  "message": "かしこまりました。〜ですね。おすすめの{shop_count}軒をご紹介します。\\n\\n1. **店舗名**（エリア）- 料理の特徴、予算帯、雰囲気を含む2〜3文の説明\\n\\n...(全{shop_count}店舗)\\n\\n気になるお店があれば、お気軽にお聞きください。",
  "descriptions": [
    {{
      "description": "料理内容・体験価値・雰囲気を含む要約（2〜3文）",
      "highlights": ["特徴1", "特徴2", "特徴3"],
      "tips": "来店時のおすすめポイント",
      "specialty": "看板メニューや得意料理",
      "atmosphere": "雰囲気",
      "features": "特色"
    }}
  ]
}}

重要:
- messageの冒頭に「かしこまりました」等の返事とユーザーのリクエストの復唱を入れる
- messageフィールド内の予算は漢数字（音声読み上げ対応）
- 店舗名は**太字**
- 各店舗について料理の特徴、雰囲気、予算帯を含む2〜3文の説明
- descriptions配列は検索結果と同じ順序・同じ件数で出力
- JSONのみ出力（マークダウンコードブロック不要）"""

            elif language == 'en':
                prompt = f"""Generate detailed descriptions for these restaurant search results.

User request: {user_query}

Results:
{shop_list_str}

Output as JSON only:
{{
  "message": "Here are {shop_count} recommended restaurants for you.\\n\\n1. **Name** (Area) - 2-3 sentence description with cuisine, price range, atmosphere...\\n\\n...(all {shop_count})\\n\\nFeel free to ask about any restaurant.",
  "descriptions": [
    {{
      "description": "2-3 sentence summary",
      "highlights": ["Feature 1", "Feature 2", "Feature 3"],
      "tips": "Recommended point",
      "specialty": "Signature dish",
      "atmosphere": "Atmosphere",
      "features": "Features"
    }}
  ]
}}"""
            elif language == 'zh':
                prompt = f"""为以下餐厅搜索结果生成详细介绍。

用户请求: {user_query}

搜索结果:
{shop_list_str}

请以JSON格式输出:
{{
  "message": "好的，为您推荐{shop_count}家餐厅。\\n\\n1. **店名**（区域）- 2-3句介绍...\\n\\n请问有感兴趣的餐厅吗？",
  "descriptions": [
    {{
      "description": "2-3句概述",
      "highlights": ["特色1", "特色2", "特色3"],
      "tips": "推荐要点",
      "specialty": "招牌菜",
      "atmosphere": "氛围",
      "features": "特色"
    }}
  ]
}}"""
            elif language == 'ko':
                prompt = f"""다음 레스토랑 검색 결과에 대한 상세 설명을 생성하세요.

사용자 요청: {user_query}

검색 결과:
{shop_list_str}

JSON 형식으로 출력:
{{
  "message": "알겠습니다. {shop_count}개의 레스토랑을 추천합니다.\\n\\n1. **이름** (지역) - 2-3문장 설명...\\n\\n궁금한 레스토랑이 있으시면 말씀해 주세요.",
  "descriptions": [
    {{
      "description": "2-3문장 요약",
      "highlights": ["특징1", "특징2", "특징3"],
      "tips": "추천 포인트",
      "specialty": "대표 메뉴",
      "atmosphere": "분위기",
      "features": "특색"
    }}
  ]
}}"""
            else:
                prompt = f"Generate descriptions for: {shop_list_str}\nUser query: {user_query}"

            logger.info(f"[LiveSession] Generating descriptions via REST API: {shop_count} shops")

            response = client.models.generate_content(
                model=REST_API_MODEL,
                contents=prompt
            )

            text = response.text
            if not text:
                return None

            # JSON パース（コードブロック除去対応）
            clean = text.strip()
            if clean.startswith('```'):
                # ```json ... ``` を除去
                first_nl = clean.find('\n')
                last_fence = clean.rfind('```')
                if first_nl > 0 and last_fence > first_nl:
                    clean = clean[first_nl + 1:last_fence].strip()

            start = clean.find('{')
            if start < 0:
                return None

            brace_count = 0
            end = -1
            for idx in range(start, len(clean)):
                if clean[idx] == '{':
                    brace_count += 1
                elif clean[idx] == '}':
                    brace_count -= 1
                    if brace_count == 0:
                        end = idx + 1
                        break

            if end < 0:
                return None

            result = json.loads(clean[start:end])
            logger.info(f"[LiveSession] Description generation success: "
                       f"message={len(result.get('message', ''))} chars, "
                       f"descriptions={len(result.get('descriptions', []))} items")
            return result

        except Exception as e:
            logger.error(f"[LiveSession] Description generation error: {e}")
            return None

    def _build_shop_intro_text(self, shops, language):
        """ショップ紹介テキストを構築（Cloud TTS用）"""
        count = len(shops)
        if count == 0:
            return ''

        shop_names = [s.get('name', '') for s in shops[:3]]
        names_str = '、'.join(shop_names)

        if language == 'ja':
            text = f'お待たせしました。{count}件のお店が見つかりました。'
            text += f'{names_str}などがございます。'
            text += '画面のカードをご覧くださいませ。気になるお店があればお気軽にお聞きくださいね。'
        elif language == 'en':
            text = f"Thank you for waiting. I found {count} restaurants. "
            text += f"Including {', '.join(shop_names[:3])}. "
            text += "Please check the cards on screen. Feel free to ask about any restaurant."
        elif language == 'zh':
            text = f"让您久等了。找到了{count}家餐厅。"
            text += f"包括{names_str}等。"
            text += "请查看屏幕上的卡片。如果有感兴趣的餐厅，请随时询问。"
        elif language == 'ko':
            text = f"기다려 주셔서 감사합니다. {count}개의 레스토랑을 찾았습니다. "
            text += f"{names_str} 등이 있습니다. "
            text += "화면의 카드를 확인해 주세요. 궁금한 레스토랑이 있으시면 편하게 물어보세요."
        else:
            text = f'お待たせしました。{count}件のお店が見つかりました。'

        return text

    def _generate_tts(self, text, language):
        """Cloud TTS で音声合成（ショップカード紹介用）"""
        try:
            from google.cloud import texttospeech

            lang_code, voice_name = VOICE_MAP.get(language, VOICE_MAP['ja'])

            tts_client = texttospeech.TextToSpeechClient()
            synthesis_input = texttospeech.SynthesisInput(text=text[:1000])
            voice = texttospeech.VoiceSelectionParams(
                language_code=lang_code,
                name=voice_name
            )
            audio_config = texttospeech.AudioConfig(
                audio_encoding=texttospeech.AudioEncoding.MP3
            )

            response = tts_client.synthesize_speech(
                input=synthesis_input,
                voice=voice,
                audio_config=audio_config
            )

            return base64.b64encode(response.audio_content).decode('utf-8')

        except Exception as e:
            logger.error(f"[LiveSession] TTS error: {e}")
            return ''

    # ============================================================
    # Flask スレッドから呼ばれるメソッド
    # ============================================================

    def send_audio(self, audio_base64):
        """
        ブラウザからの音声チャンクを Gemini にリレー
        stt_stream.py listen_audio 準拠: {"data": bytes, "mime_type": "audio/pcm"}
        """
        if self.loop and self.audio_queue is not None:
            try:
                audio_bytes = base64.b64decode(audio_base64)
                msg = {"data": audio_bytes, "mime_type": "audio/pcm"}
                # stt_stream.py 準拠: put_nowait() で溢れたら捨てる（ブロックしない）
                self.audio_queue.put_nowait(msg)
            except asyncio.QueueFull:
                pass  # stt_stream.py 準拠: 溢れたチャンクは破棄
            except Exception as e:
                logger.error(f"[LiveSession] Audio queue error: {e}")

    def send_text(self, text):
        """
        テキスト入力を Gemini に送信
        stt_stream.py: session.send_client_content(turns=..., turn_complete=True)
        """
        if self.loop and self.gemini_session is not None:
            async def _send():
                try:
                    await self.gemini_session.send_client_content(
                        turns=types.Content(
                            role="user",
                            parts=[types.Part(text=text)]
                        ),
                        turn_complete=True
                    )
                except Exception as e:
                    logger.error(f"[LiveSession] Text send error: {e}")

            asyncio.run_coroutine_threadsafe(_send(), self.loop)

    def close(self):
        """セッション終了"""
        self.running = False
        if self.loop and self.audio_queue:
            try:
                asyncio.run_coroutine_threadsafe(
                    self.audio_queue.put(None),
                    self.loop
                )
            except Exception:
                pass
        if self.thread:
            self.thread.join(timeout=5)
        logger.info(f"[LiveSession] Closed: session={self.session_id}")


class LiveSessionManager:
    """LiveAPI セッションの管理"""

    def __init__(self):
        self.sessions = {}

    def create(self, session_id, system_prompt, ws, language='ja', mode='chat',
               user_context=''):
        self.remove(session_id)
        session = LiveSession(session_id, system_prompt, ws, language, mode, user_context)
        self.sessions[session_id] = session
        session.start()
        return session

    def get(self, session_id):
        return self.sessions.get(session_id)

    def remove(self, session_id):
        session = self.sessions.pop(session_id, None)
        if session:
            session.close()
