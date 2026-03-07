"""
Gemini Live API WebSocket 中継

処理順序:
1. Gemini Live API セッションを開始
2. フロントエンドからのメッセージを受信
3. Gemini に転送
4. Gemini からの応答をフロントエンドに転送
5. tool_call を検知したらレストラン検索を実行
"""

import asyncio
import json
import logging
from typing import Optional

from fastapi import WebSocket
from google import genai
from google.genai import types

from ..config import GEMINI_API_KEY, GEMINI_MODEL

logger = logging.getLogger(__name__)


class LiveRelay:
    def __init__(self, websocket: WebSocket, session: dict):
        self.websocket = websocket
        self.session = session
        self._gemini_session = None
        self._client = None
        self._running = False

    async def run(self):
        """
        処理順序:
        1. Gemini クライアント初期化
        2. Live API セッション開始
        3. フロントエンドに connected 通知
        4. 受信ループ開始（フロントエンド → Gemini）
        5. 応答ループ開始（Gemini → フロントエンド）
        """
        self._running = True

        # 1. Gemini クライアント初期化
        self._client = genai.Client(api_key=GEMINI_API_KEY)

        # 2. Live API セッション開始
        system_prompt = self._build_system_prompt()
        tools = self._build_tools()

        config = types.LiveConnectConfig(
            response_modalities=["TEXT"],
            system_instruction=types.Content(
                parts=[types.Part(text=system_prompt)]
            ),
            tools=tools,
        )

        # Gemini Live API 接続
        async with self._client.aio.live.connect(
            model=GEMINI_MODEL,
            config=config,
        ) as gemini_session:
            self._gemini_session = gemini_session

            # 3. フロントエンドに connected 通知
            await self.websocket.send_json({"type": "connected"})
            logger.info("[Relay] Gemini Live session started")

            # 4 & 5. 並行ループ
            await asyncio.gather(
                self._recv_from_frontend(),
                self._recv_from_gemini(),
            )

    async def _recv_from_frontend(self):
        """フロントエンドからのメッセージを受信して Gemini に転送"""
        try:
            while self._running:
                data = await self.websocket.receive_json()
                msg_type = data.get("type")

                if msg_type == "text":
                    text = data.get("text", "")
                    if text:
                        await self._gemini_session.send(
                            input=text,
                            end_of_turn=True,
                        )
                        logger.info(f"[Relay] Sent text to Gemini: {text[:50]}...")

                elif msg_type == "close":
                    self._running = False
                    break

        except Exception as e:
            logger.error(f"[Relay] Frontend recv error: {e}")
            self._running = False

    async def _recv_from_gemini(self):
        """Gemini からの応答を受信してフロントエンドに転送"""
        try:
            while self._running:
                async for response in self._gemini_session.receive():
                    if not self._running:
                        break

                    sc = response.server_content
                    if not sc:
                        # tool_call の処理
                        if hasattr(response, "tool_call") and response.tool_call:
                            await self._handle_tool_call(response.tool_call)
                        continue

                    # テキスト応答
                    if sc.model_turn and sc.model_turn.parts:
                        for part in sc.model_turn.parts:
                            if part.text:
                                await self.websocket.send_json({
                                    "type": "text",
                                    "text": part.text,
                                })

                    # ターン完了
                    if sc.turn_complete:
                        await self.websocket.send_json({"type": "turn_complete"})
                        logger.info("[Relay] Turn complete")

        except Exception as e:
            logger.error(f"[Relay] Gemini recv error: {e}")
            self._running = False

    async def _handle_tool_call(self, tool_call):
        """
        tool_call 処理順序:
        1. function_call の名前とパラメータを取得
        2. search_restaurants の場合: Google Places API でレストラン検索
        3. 検索結果を Gemini に tool_response として返す
        4. ショップデータをフロントエンドに先行送信
        """
        for fc in tool_call.function_calls:
            if fc.name == "search_restaurants":
                args = fc.args or {}
                area = args.get("area", "")
                cuisine = args.get("cuisine", "")
                budget = args.get("budget", "")

                logger.info(
                    f"[Relay] Tool call: search_restaurants("
                    f"area={area}, cuisine={cuisine}, budget={budget})"
                )

                # Google Places API でレストラン検索
                shops = await self._search_restaurants(area, cuisine, budget)

                # ショップデータをフロントエンドに先行送信
                await self.websocket.send_json({
                    "type": "shop_data",
                    "shops": shops,
                })

                # 検索結果を Gemini に返す
                result_text = json.dumps(shops, ensure_ascii=False)
                await self._gemini_session.send(
                    input=types.Content(
                        parts=[types.Part(
                            function_response=types.FunctionResponse(
                                name="search_restaurants",
                                response={"result": result_text},
                            )
                        )]
                    ),
                    end_of_turn=False,
                )

    async def _search_restaurants(self, area: str, cuisine: str, budget: str) -> list:
        """Google Places API でレストラン検索"""
        import httpx
        from ..config import GOOGLE_PLACES_API_KEY

        query = f"{area} {cuisine} レストラン"
        if budget:
            query += f" {budget}"

        url = "https://maps.googleapis.com/maps/api/place/textsearch/json"
        params = {
            "query": query,
            "type": "restaurant",
            "key": GOOGLE_PLACES_API_KEY,
            "language": "ja",
        }

        shops = []
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(url, params=params)
                data = resp.json()

            for place in data.get("results", [])[:5]:
                name = place.get("name", "")
                encoded_name = name.replace(" ", "+")
                shop = {
                    "name": name,
                    "category": cuisine or "レストラン",
                    "description": place.get("formatted_address", ""),
                    "rating": place.get("rating"),
                    "priceRange": "",
                    "location": place.get("formatted_address", ""),
                    "image": "",
                    "hotpepper_url": f"https://www.hotpepper.jp/SA11/srchRS/?keyword={encoded_name}",
                    "maps_url": f"https://www.google.com/maps/search/{encoded_name}",
                    "tabelog_url": f"https://tabelog.com/rstLst/?vs=1&sa=&sk={encoded_name}",
                }

                # Google Places photo
                photos = place.get("photos", [])
                if photos and GOOGLE_PLACES_API_KEY:
                    photo_ref = photos[0].get("photo_reference", "")
                    if photo_ref:
                        shop["image"] = (
                            f"https://maps.googleapis.com/maps/api/place/photo"
                            f"?maxwidth=400&photo_reference={photo_ref}"
                            f"&key={GOOGLE_PLACES_API_KEY}"
                        )
                shops.append(shop)
        except Exception as e:
            logger.error(f"[Search] Google Places API error: {e}")

        return shops

    def _build_system_prompt(self) -> str:
        """システムプロンプト — mode に応じて切り替え"""
        mode = self.session.get("mode", "gourmet")
        language = self.session.get("language", "ja")

        base_prompt = """あなたはグルメサポートAIです。ユーザーの食事の好みや要望を聞いて、最適なレストランを提案します。

## 応答ルール
- 丁寧で親しみやすい口調で応答してください
- ユーザーの要望（エリア、ジャンル、予算、人数など）を聞き出してください
- 十分な情報が集まったら search_restaurants 関数を呼び出してください
- 関数を呼び出す前に、ユーザーに確認してください

## 応答の長さ制限
- 1回の応答は原則30文字以内（日本語）を目安にしてください
- 長い説明が必要な場合は複数ターンに分けてください
- 短い応答の方がユーザーとの対話がテンポよく進みます
- ただし、ショップ紹介時は詳細な説明をしてください
"""

        if mode == "concierge":
            base_prompt += """
## コンシェルジュモード追加ルール
- より丁寧な接客口調で応答してください
- 「いらっしゃいませ」「承知しました」などの接客用語を使ってください
"""

        if language != "ja":
            lang_map = {"en": "English", "zh": "Chinese", "ko": "Korean"}
            base_prompt += f"\n## 言語\n{lang_map.get(language, 'Japanese')}で応答してください。\n"

        return base_prompt

    def _build_tools(self) -> list:
        """Function Calling 定義"""
        search_tool = types.Tool(
            function_declarations=[
                types.FunctionDeclaration(
                    name="search_restaurants",
                    description="指定されたエリア・ジャンル・予算でレストランを検索する",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "area": types.Schema(
                                type=types.Type.STRING,
                                description="検索エリア（例: 渋谷、新宿、恵比寿）",
                            ),
                            "cuisine": types.Schema(
                                type=types.Type.STRING,
                                description="料理ジャンル（例: イタリアン、和食、フレンチ）",
                            ),
                            "budget": types.Schema(
                                type=types.Type.STRING,
                                description="予算範囲（例: 3000-5000円）",
                            ),
                        },
                        required=["area"],
                    ),
                )
            ]
        )
        return [search_tool]

    async def close(self):
        """セッション終了"""
        self._running = False
