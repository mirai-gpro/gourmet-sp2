# -*- coding: utf-8 -*-
"""
LiveAPI WebSocket セッション管理

stt_stream.py の実装パターンを厳密に踏襲。
差異がある場合は stt_stream.py を正とする。

stt_stream.py からの移植対応表:
  - pyaudio入出力 → ブラウザWebSocketリレー
  - ローカル実行 → Flask バックグラウンドスレッド
  - 会議アシスタント用ツール → update_user_profile ツール（コンシェルジュのみ）
  - REST API (gemini-2.5-flash) → 既存 support_core.py に委譲（search_restaurants は REST API 側で処理）
"""
import asyncio
import base64
import json
import logging
import os
import threading

from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

# ============================================================
# 設定（stt_stream.py 準拠）
# ============================================================
LIVE_API_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"
SEND_SAMPLE_RATE = 16000
RECEIVE_SAMPLE_RATE = 24000

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

### レストラン検索時の応答フロー（必ず守ること）

1. **復唱+お待ち（必須）**: ユーザーのリクエストを短く復唱し、検索する旨を伝える（1文で）
   - 例: 「恵比寿で焼き鳥ですね、お探しします！」
   - 例: 「渋谷のイタリアンですね、少々お待ちください。」
   - 例: 「かしこまりました。新宿で和食ですね、お調べします。」
   - **この復唱は必ず声に出してから**ツールを呼び出すこと

2. **ツール呼び出し**: 上記を話した後に search_restaurants を呼び出す

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
def build_live_config(system_prompt, mode='chat'):
    """
    Live API 設定を構築（stt_stream.py _build_config 準拠）

    stt_stream.py との差異:
      - voice_name: "Aoede" を追加（グルメアプリ用の声）
      - tools: update_user_profile（コンシェルジュのみ）
      - automatic_activity_detection: HIGH感度（自動VADでターン検知）
      - prefix_padding_ms: 100（stt_stream.py 準拠）
    """
    # モード別ツール構成（search_restaurants は REST API 側で処理、LiveAPI には不要）
    tools = []
    if mode == 'concierge':
        tools.append(UPDATE_PROFILE_TOOL)

    config = {
        "response_modalities": ["AUDIO"],
        "system_instruction": system_prompt,
        "input_audio_transcription": {},
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
                "prefix_padding_ms": 100,
                "silence_duration_ms": 500,
            }
        },
        "context_window_compression": {
            "sliding_window": {
                "target_tokens": 32000,
            }
        },
    }
    if tools:
        config["tools"] = tools
    return config


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

                    # 入力トランスクリプション（stt_stream.py: input_transcription）
                    if hasattr(sc, 'input_transcription') and sc.input_transcription:
                        text = sc.input_transcription.text
                        if text:
                            self._add_to_history('User', text)
                            self._ws_send(json.dumps({
                                'type': 'input_transcription',
                                'data': text
                            }))

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
        """
        for fc in tool_call.function_calls:
            logger.info(f"[LiveSession] Tool call: {fc.name}, args={fc.args}")

            if fc.name == "update_user_profile":
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
