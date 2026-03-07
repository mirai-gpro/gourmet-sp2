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

# Cloud TTS 音声マッピング（ショップカード紹介用、REST フォールバック時に使用）
VOICE_MAP = {
    'ja': ('ja-JP', 'ja-JP-Chirp3-HD-Leda'),
    'en': ('en-US', 'en-US-Studio-O'),
    'zh': ('cmn-CN', 'cmn-CN-Wavenet-A'),
    'ko': ('ko-KR', 'ko-KR-Wavenet-A')
}


def build_live_config(system_prompt):
    """
    Live API 設定を構築（stt_stream.py _build_config 準拠）

    stt_stream.py との差異:
      - voice_name: "Aoede" を追加（グルメアプリ用の声）
      - tools: search_restaurants を追加
    """
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
        "tools": [SEARCH_TOOL],
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

    def __init__(self, session_id, system_prompt, ws, language='ja', mode='chat'):
        self.session_id = session_id
        self.system_prompt = system_prompt
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
        config = build_live_config(self.system_prompt)

        logger.info(f"[LiveSession] Connecting: model={LIVE_API_MODEL}, session={self.session_id}")

        async with client.aio.live.connect(
            model=LIVE_API_MODEL,
            config=config
        ) as session:
            self.gemini_session = session
            self.audio_queue = asyncio.Queue(maxsize=5)

            self._ws_send(json.dumps({'type': 'live_ready'}))
            logger.info(f"[LiveSession] Connected: session={self.session_id}")

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
            else:
                logger.warning(f"[LiveSession] Unknown tool: {fc.name}")

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

    def create(self, session_id, system_prompt, ws, language='ja', mode='chat'):
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
