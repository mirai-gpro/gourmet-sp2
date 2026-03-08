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

### 応答スタイル
- 丁寧だが堅すぎない、親しみやすいコンシェルジュ口調
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

検索フロー:
1. **復唱**: ユーザーのリクエスト内容を自然に復唱する
   例: 「恵比寿で焼き鳥のお店をお探しですね！」
2. **お待ちメッセージ**: 検索する旨を伝える
   例: 「お調べしますので、少々お待ちください。」
3. **ツール呼び出し**: search_restaurants ツールを呼び出す
4. **結果紹介**: ツール結果を受けたら簡潔に紹介する
   例: 「5件のお店が見つかりました。画面にカードが表示されていますので、ぜひご覧ください。気になるお店があればお気軽にお聞きくださいね。」

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
      - prefix_padding_ms: 100（stt_stream.py 準拠）
    """
    # モード別ツール構成
    tools = [SEARCH_TOOL]
    if mode == 'concierge':
        tools.append(UPDATE_PROFILE_TOOL)

    return {
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

    async def _session_loop(self):
        """
        Gemini LiveAPI メインセッションループ
        stt_stream.py GeminiLiveApp.run → _session_loop 準拠
        """
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY が設定されていません")

        client = genai.Client(api_key=api_key)
        config = build_live_config(self.system_prompt, self.mode)

        logger.info(f"[LiveSession] Connecting: model={LIVE_API_MODEL}, session={self.session_id}")

        async with client.aio.live.connect(
            model=LIVE_API_MODEL,
            config=config
        ) as session:
            self.gemini_session = session
            self.audio_queue = asyncio.Queue(maxsize=5)

            self._ws_send(json.dumps({'type': 'live_ready'}))
            logger.info(f"[LiveSession] Connected: session={self.session_id}")

            # LiveAPI仕様: モデルが先に話すにはダミーのユーザー発話が必要
            # 公式ドキュメント推奨のワークアラウンド
            await session.send_client_content(
                turns=types.Content(
                    role="user",
                    parts=[types.Part(text="こんにちは")]
                ),
                turn_complete=True
            )
            logger.info(f"[LiveSession] Initial trigger sent")

            # stt_stream.py: TaskGroup で send_audio, receive, play_audio を並行実行
            try:
                await asyncio.gather(
                    self._send_audio(session),
                    self._receive(session)
                )
            except Exception as e:
                if self.running:
                    logger.error(f"[LiveSession] Loop error: {e}")

    async def _send_audio(self, session):
        """
        キューから音声を取得して Gemini に送信
        stt_stream.py send_audio 準拠: session.send_realtime_input(audio=msg)
        """
        while self.running:
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
        stt_stream.py receive_audio 準拠
        """
        try:
            while self.running:
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
                        self._ws_send(json.dumps({'type': 'turn_complete'}))

                    # 割り込み検知（stt_stream.py: interrupted）
                    if hasattr(sc, 'interrupted') and sc.interrupted:
                        self._ws_send(json.dumps({'type': 'interrupted'}))
                        continue

                    # 入力トランスクリプション（stt_stream.py: input_transcription）
                    if hasattr(sc, 'input_transcription') and sc.input_transcription:
                        text = sc.input_transcription.text
                        if text:
                            self._ws_send(json.dumps({
                                'type': 'input_transcription',
                                'data': text
                            }))

                    # 出力トランスクリプション（stt_stream.py: output_transcription）
                    if hasattr(sc, 'output_transcription') and sc.output_transcription:
                        text = sc.output_transcription.text
                        if text:
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
                logger.error(f"[LiveSession] Receive error: {e}")
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
                response_text = result.get('response', '')
                tts_audio = result.get('tts_audio', '')

                # ショップデータをブラウザに送信
                self._ws_send(json.dumps({
                    'type': 'shops',
                    'data': {
                        'response': response_text,
                        'shops': shops,
                        'ttsAudio': tts_audio
                    }
                }))

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
        HotPepper API で直接検索 → Google Places 等で enrichment

        旧実装では support_core.process_user_message() 経由で REST Gemini API を
        二重呼び出ししていたが、LiveAPI の Gemini が既に query/area を抽出済みのため不要。
        これにより:
          - 20秒→数秒に短縮（REST Gemini API 呼び出し削除）
          - チャットモードのセッション不整合エラー解消
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

            # Google Places / 食べログ / ぐるなび 等で enrichment
            shops = enrich_shops_with_photos(shops, area, language) or []

            logger.info(f"[LiveSession] Search complete: {len(shops)} shops")

            # Cloud TTS でショップ紹介音声を生成（即時再生用）
            intro_text = self._build_shop_intro_text(shops, language)
            tts_audio = self._generate_tts(intro_text, language) if intro_text else ''

            return {'shops': shops, 'response': intro_text, 'tts_audio': tts_audio}

        except Exception as e:
            logger.error(f"[LiveSession] Restaurant search error: {e}")
            return {'shops': [], 'response': '', 'tts_audio': ''}

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
                asyncio.run_coroutine_threadsafe(
                    self.audio_queue.put(msg),
                    self.loop
                )
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
