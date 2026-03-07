
# -*- coding: utf-8 -*-
"""
LiveAPI WebSocket セッション管理
stt_stream.py の実装パターンに基づく Gemini LiveAPI 双方向ストリーム

🚨 改変禁止: モデル名・設定値は stt_stream.py の本番稼働値と同一
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

# ========================================
# 🚨 改変禁止: LiveAPI接続パラメータ
# stt_stream.py の本番稼働値と同一
# ========================================
LIVE_API_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"

LIVE_API_CONFIG = {
    "response_modalities": ["AUDIO", "TEXT"],
    "speech_config": {
        "voice_config": {
            "prebuilt_voice_config": {
                "voice_name": "Aoede"
            }
        }
    }
}

# 🚨 検証: 仕様書 Section 6-1 の assert
assert LIVE_API_MODEL == "gemini-2.5-flash-native-audio-preview-12-2025", "モデル名が改変されています"
assert "AUDIO" in LIVE_API_CONFIG["response_modalities"]
assert "TEXT" in LIVE_API_CONFIG["response_modalities"]

# ショップ検索ツール定義
SEARCH_TOOL = {
    "function_declarations": [
        {
            "name": "search_restaurants",
            "description": "ユーザーの要望に基づいてレストランを検索します。エリアや料理ジャンル、雰囲気、予算などの条件でお店を探します。ユーザーがお店を探していると判断した場合にこのツールを呼び出してください。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "検索クエリ（料理ジャンル、雰囲気、予算、条件など。例: '恵比寿で美味しいイタリアン'）"
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

# 言語 → Cloud TTS音声マッピング（ショップカード紹介用）
VOICE_MAP = {
    'ja': ('ja-JP', 'ja-JP-Chirp3-HD-Leda'),
    'en': ('en-US', 'en-US-Studio-O'),
    'zh': ('cmn-CN', 'cmn-CN-Wavenet-A'),
    'ko': ('ko-KR', 'ko-KR-Wavenet-A')
}


class LiveSession:
    """
    単一のGemini LiveAPI セッション
    ブラウザWebSocket ↔ バックエンド ↔ Gemini LiveAPI WebSocket の双方向リレー
    """

    def __init__(self, session_id, system_prompt, ws, language='ja', mode='chat'):
        self.session_id = session_id
        self.system_prompt = system_prompt
        self.ws = ws
        self.language = language
        self.mode = mode
        self.loop = None
        self.gemini_session = None
        self.send_queue = None
        self.running = False
        self.thread = None
        self._ws_lock = threading.Lock()

    def start(self):
        """バックグラウンドスレッドでLiveAPIセッションを開始"""
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _ws_send(self, data):
        """スレッドセーフなWebSocket送信"""
        with self._ws_lock:
            try:
                self.ws.send(data)
            except Exception as e:
                logger.error(f"[LiveSession] WS send error: {e}")

    def _run(self):
        """asyncio event loop for Gemini LiveAPI session"""
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
        """Gemini LiveAPI メインセッションループ"""
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY が設定されていません")

        client = genai.Client(api_key=api_key)

        # 🚨 改変禁止: LiveConnectConfig は仕様書 Section 3-1-1 準拠
        config = types.LiveConnectConfig(
            response_modalities=["AUDIO", "TEXT"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name="Aoede"
                    )
                )
            ),
            system_instruction=types.Content(
                parts=[types.Part(text=self.system_prompt)]
            ),
            tools=[SEARCH_TOOL]
        )

        logger.info(f"[LiveSession] Connecting to Gemini LiveAPI: model={LIVE_API_MODEL}, session={self.session_id}")

        async with client.aio.live.connect(
            model=LIVE_API_MODEL,
            config=config
        ) as session:
            self.gemini_session = session
            self.send_queue = asyncio.Queue()

            # フロントエンドに接続完了を通知
            self._ws_send(json.dumps({'type': 'live_ready'}))
            logger.info(f"[LiveSession] Connected: session={self.session_id}")

            # 受信ループと送信ループを並行実行
            try:
                await asyncio.gather(
                    self._receive_loop(session),
                    self._send_loop(session)
                )
            except Exception as e:
                if self.running:
                    logger.error(f"[LiveSession] Loop error: {e}")

    async def _receive_loop(self, session):
        """Geminiからのレスポンスを受信してブラウザにリレー"""
        try:
            async for response in session.receive():
                if not self.running:
                    break
                await self._handle_response(session, response)
        except Exception as e:
            if self.running:
                logger.error(f"[LiveSession] Receive error: {e}")
                self._ws_send(json.dumps({'type': 'error', 'data': str(e)}))

    async def _send_loop(self, session):
        """キューからデータを取得してGeminiに送信"""
        while self.running:
            try:
                item = await asyncio.wait_for(self.send_queue.get(), timeout=1.0)
                if item is None:
                    break

                # テキスト入力: (text, end_of_turn) タプル
                if isinstance(item, tuple):
                    text, end_of_turn = item
                    await session.send(input=text, end_of_turn=end_of_turn)
                # 音声入力: LiveClientRealtimeInput
                else:
                    await session.send(input=item)

            except asyncio.TimeoutError:
                continue
            except Exception as e:
                if self.running:
                    logger.error(f"[LiveSession] Send error: {e}")

    async def _handle_response(self, session, response):
        """Gemini LiveAPIレスポンスを処理"""
        # モデル応答（音声 + テキスト）
        if hasattr(response, 'server_content') and response.server_content:
            content = response.server_content

            if hasattr(content, 'model_turn') and content.model_turn:
                for part in content.model_turn.parts:
                    if hasattr(part, 'text') and part.text:
                        self._ws_send(json.dumps({
                            'type': 'text',
                            'data': part.text
                        }))

                    if hasattr(part, 'inline_data') and part.inline_data:
                        audio_b64 = base64.b64encode(
                            part.inline_data.data
                        ).decode('utf-8')
                        self._ws_send(json.dumps({
                            'type': 'audio',
                            'data': audio_b64
                        }))

            # ターン完了
            if hasattr(content, 'turn_complete') and content.turn_complete:
                self._ws_send(json.dumps({'type': 'turn_complete'}))

        # ツールコール（ショップ検索等）
        if hasattr(response, 'tool_call') and response.tool_call:
            await self._handle_tool_call(session, response.tool_call)

    async def _handle_tool_call(self, session, tool_call):
        """
        ツールコール処理
        🚨 仕様書 Section 3-1-3 処理順序を厳守:
        1. tool_call 受信
        2. function_name 判定
        3. search_restaurants → 既存コードでショップ検索 → 結果をフロントエンドに送信
        4. それ以外 → Gemini に結果を返して会話続行
        """
        for fc in tool_call.function_calls:
            logger.info(f"[LiveSession] Tool call: {fc.name}, args={fc.args}")

            if fc.name == "search_restaurants":
                query = fc.args.get("query", "") if fc.args else ""
                area = fc.args.get("area", "") if fc.args else ""

                # 同期処理をexecutorで実行（既存コード使用）
                loop = asyncio.get_event_loop()
                result = await loop.run_in_executor(
                    None,
                    lambda q=query, a=area: self._execute_restaurant_search(q, a)
                )

                shops = result.get('shops', [])
                response_text = result.get('response', '')
                tts_audio = result.get('tts_audio', '')

                # ショップデータをフロントエンドに送信
                self._ws_send(json.dumps({
                    'type': 'shops',
                    'data': {
                        'response': response_text,
                        'shops': shops,
                        'ttsAudio': tts_audio
                    }
                }))

                logger.info(f"[LiveSession] Shop search result: {len(shops)} shops")

                # ツール結果をGeminiに返す
                try:
                    shop_names = [s.get('name', '') for s in shops]
                    tool_response = types.LiveClientToolResponse(
                        function_responses=[
                            types.FunctionResponse(
                                name="search_restaurants",
                                response={
                                    "result": f"{len(shops)}件のレストランが見つかりました",
                                    "shops": shop_names
                                }
                            )
                        ]
                    )
                    await session.send(input=tool_response)
                except Exception as e:
                    logger.error(f"[LiveSession] Tool response send error: {e}")
            else:
                logger.warning(f"[LiveSession] Unknown tool call: {fc.name}")

    def _execute_restaurant_search(self, query, area):
        """
        既存の support_core.py + api_integrations.py でショップ検索実行
        🚨 既存ロジック維持: support_core.py / api_integrations.py は変更しない
        """
        try:
            from support_core import SupportSession, SupportAssistant, SYSTEM_PROMPTS
            from api_integrations import enrich_shops_with_photos, extract_area_from_text

            session = SupportSession(self.session_id)
            session_data = session.get_data()

            if not session_data:
                logger.warning(f"[LiveSession] Session not found: {self.session_id}")
                return {'shops': [], 'response': '', 'tts_audio': ''}

            language = session_data.get('language', self.language)

            assistant = SupportAssistant(session, SYSTEM_PROMPTS)
            result = assistant.process_user_message(query, 'conversation')

            shops = result.get('shops') or []
            response_text = result.get('response', '')

            if shops:
                if not area:
                    area = extract_area_from_text(query, language)
                shops = enrich_shops_with_photos(shops, area, language) or []

                # Cloud TTS で長文の紹介セリフを音声合成（既存ロジック維持）
                if shops:
                    tts_audio = self._generate_tts(response_text, language)
                    return {
                        'shops': shops,
                        'response': response_text,
                        'tts_audio': tts_audio
                    }

            return {'shops': shops, 'response': response_text, 'tts_audio': ''}

        except Exception as e:
            logger.error(f"[LiveSession] Restaurant search error: {e}")
            return {'shops': [], 'response': '', 'tts_audio': ''}

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

    def send_audio(self, audio_base64):
        """ブラウザからの音声チャンクをGeminiにリレー"""
        if self.loop and self.send_queue is not None:
            try:
                audio_bytes = base64.b64decode(audio_base64)
                data = types.LiveClientRealtimeInput(
                    media_chunks=[types.Blob(
                        data=audio_bytes,
                        mime_type="audio/pcm;rate=16000"
                    )]
                )
                asyncio.run_coroutine_threadsafe(
                    self.send_queue.put(data),
                    self.loop
                )
            except Exception as e:
                logger.error(f"[LiveSession] Audio queue error: {e}")

    def send_text(self, text):
        """テキスト入力をGeminiに送信（end_of_turn=True で応答を促す）"""
        if self.loop and self.send_queue is not None:
            asyncio.run_coroutine_threadsafe(
                self.send_queue.put((text, True)),
                self.loop
            )

    def close(self):
        """セッション終了"""
        self.running = False
        if self.loop and self.send_queue:
            try:
                asyncio.run_coroutine_threadsafe(
                    self.send_queue.put(None),
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

    def create(self, session_id, system_prompt, ws, language='ja', mode='chat'):
        # 既存セッションがあれば閉じる
        self.remove(session_id)

        session = LiveSession(session_id, system_prompt, ws, language, mode)
        self.sessions[session_id] = session
        session.start()
        return session

    def get(self, session_id):
        return self.sessions.get(session_id)

    def remove(self, session_id):
        session = self.sessions.pop(session_id, None)
        if session:
            session.close()
