import asyncio
import json
import logging

import httpx
from google import genai
from google.genai import types

from ..config import GEMINI_API_KEY, GEMINI_MODEL, GOOGLE_PLACES_API_KEY

logger = logging.getLogger(__name__)


# search_restaurants ツール定義
SEARCH_RESTAURANTS_TOOL = types.Tool(
    function_declarations=[
        types.FunctionDeclaration(
            name="search_restaurants",
            description="指定された条件でレストランを検索します。ユーザーが場所やジャンルを指定した場合に使用してください。",
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "query": types.Schema(
                        type=types.Type.STRING,
                        description="検索クエリ（例: '渋谷 イタリアン'）",
                    ),
                    "location": types.Schema(
                        type=types.Type.STRING,
                        description="場所（例: '渋谷'）",
                    ),
                    "cuisine": types.Schema(
                        type=types.Type.STRING,
                        description="料理ジャンル（例: 'イタリアン'）",
                    ),
                },
                required=["query"],
            ),
        )
    ]
)


class LiveRelay:
    def __init__(self, websocket, session: dict):
        self.websocket = websocket
        self.session = session
        self._running = False
        self._gemini_session = None

    async def run(self):
        """
        🚨 処理フロー（設計書 2.4 準拠）:
        1. Gemini クライアント初期化
        2. システムプロンプト構築
        3. Function Calling ツール定義
        4. LiveConnectConfig 構築（response_modalities=["TEXT"]）
        5. Gemini Live API 接続
        6. フロントエンドに { type: "connected" } 送信
        7. 並行ループ開始
        """
        # 1. Gemini クライアント初期化
        client = genai.Client(api_key=GEMINI_API_KEY)

        # 2. システムプロンプト構築
        system_prompt = self.session.get("system_prompt", "")

        # 3 & 4. LiveConnectConfig 構築
        # 🚨 response_modalities=["TEXT"] — テキスト応答のみ（音声はREST TTSで生成）
        config = types.LiveConnectConfig(
            response_modalities=["TEXT"],
            system_instruction=types.Content(
                parts=[types.Part(text=system_prompt)]
            ) if system_prompt else None,
            tools=[SEARCH_RESTAURANTS_TOOL],
        )

        # 5. Gemini Live API 接続
        # 🚨 AI知識不足: connect() のシグネチャは google-genai バージョンに依存
        # TODO: 手動検証 — connect() の正確なインターフェースを確認すること
        async with client.aio.live.connect(
            model=GEMINI_MODEL,
            config=config,
        ) as session:
            self._gemini_session = session
            self._running = True

            # 6. フロントエンドに接続確立を通知
            await self.websocket.send_json({"type": "connected"})
            logger.info("Gemini Live API session connected")

            # 7. 並行ループ開始
            await asyncio.gather(
                self._frontend_to_gemini(),
                self._gemini_to_frontend(),
            )

    async def _frontend_to_gemini(self):
        """フロントエンド → Gemini 転送ループ"""
        while self._running:
            try:
                raw = await self.websocket.receive_text()
                data = json.loads(raw)
                msg_type = data.get("type", "")

                if msg_type == "text":
                    # 🚨 フィールド名は "text"（"data" ではない）
                    text = data.get("text", "")
                    if text and self._gemini_session:
                        await self._gemini_session.send(input=text, end_of_turn=True)
                        logger.info(f"Sent text to Gemini: {text[:50]}...")

                elif msg_type == "audio":
                    # フェーズ1: pass（音声入力は将来対応）
                    pass

                elif msg_type == "close":
                    self._running = False
                    break

            except Exception as e:
                logger.error(f"Frontend→Gemini error: {e}")
                self._running = False
                break

    async def _gemini_to_frontend(self):
        """Gemini → フロントエンド 転送ループ"""
        while self._running:
            try:
                if not self._gemini_session:
                    break

                # 🚨 AI知識不足: receive() のシグネチャは google-genai バージョンに依存
                # TODO: 手動検証 — async for vs await receive() の正確なインターフェースを確認
                async for response in self._gemini_session.receive():
                    if not self._running:
                        break

                    sc = response.server_content
                    if not sc:
                        # tool_call チェック
                        if hasattr(response, "tool_call") and response.tool_call:
                            await self._handle_tool_call(response.tool_call)
                        continue

                    # テキスト応答チャンク
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

            except Exception as e:
                logger.error(f"Gemini→Frontend error: {e}")
                self._running = False
                break

    async def _handle_tool_call(self, tool_call):
        """
        🚨 tool_call 処理フロー（設計書 2.4 準拠）:
        1. function_call の名前とパラメータを取得
        2. search_restaurants の場合: Google Places API でレストラン検索
        3. ショップデータをフロントエンドに先行送信
        4. 検索結果を Gemini に tool_response として返す
        """
        for fc in tool_call.function_calls:
            if fc.name == "search_restaurants":
                args = fc.args or {}
                query = args.get("query", "")
                location = args.get("location", "")

                # Google Places API でレストラン検索
                shops = await self._search_places(query, location)

                # 3. ショップデータをフロントエンドに先行送信
                await self.websocket.send_json({
                    "type": "shop_data",
                    "shops": shops,
                })

                # 4. 検索結果を Gemini に tool_response として返す
                # 🚨 AI知識不足: tool_response の送信方法は google-genai バージョンに依存
                # TODO: 手動検証 — send() で tool_response を送る正確な方法を確認
                result_text = json.dumps(shops[:5], ensure_ascii=False) if shops else "検索結果が見つかりませんでした"
                try:
                    await self._gemini_session.send(
                        input=types.LiveClientToolResponse(
                            function_responses=[
                                types.FunctionResponse(
                                    name="search_restaurants",
                                    response={"results": result_text},
                                )
                            ]
                        ),
                        end_of_turn=False,
                    )
                except Exception as e:
                    logger.error(f"Tool response error: {e}")
                    # フォールバック: テキストとして結果を送信
                    await self._gemini_session.send(
                        input=f"検索結果: {result_text}",
                        end_of_turn=True,
                    )

    async def _search_places(self, query: str, location: str) -> list:
        """Google Places API (Text Search) でレストラン検索"""
        if not GOOGLE_PLACES_API_KEY:
            logger.warning("GOOGLE_PLACES_API_KEY is not set")
            return []

        search_query = f"{location} {query}".strip() if location else query

        try:
            async with httpx.AsyncClient() as http_client:
                response = await http_client.post(
                    "https://places.googleapis.com/v1/places:searchText",
                    headers={
                        "Content-Type": "application/json",
                        "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
                        "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.priceLevel,places.types,places.googleMapsUri,places.photos",
                    },
                    json={
                        "textQuery": search_query,
                        "languageCode": self.session.get("language", "ja"),
                        "includedType": "restaurant",
                        "maxResultCount": 5,
                    },
                    timeout=10.0,
                )

                if response.status_code != 200:
                    logger.error(f"Places API error: {response.status_code} {response.text}")
                    return []

                data = response.json()
                places = data.get("places", [])

                shops = []
                for place in places:
                    shop = {
                        "name": place.get("displayName", {}).get("text", ""),
                        "address": place.get("formattedAddress", ""),
                        "rating": place.get("rating", 0),
                        "userRatingCount": place.get("userRatingCount", 0),
                        "priceLevel": place.get("priceLevel", ""),
                        "types": place.get("types", []),
                        "googleMapsUri": place.get("googleMapsUri", ""),
                    }

                    # 写真URL構築
                    photos = place.get("photos", [])
                    if photos:
                        photo_name = photos[0].get("name", "")
                        if photo_name:
                            shop["photoUrl"] = f"https://places.googleapis.com/v1/{photo_name}/media?maxHeightPx=400&maxWidthPx=400&key={GOOGLE_PLACES_API_KEY}"

                    shops.append(shop)

                return shops

        except Exception as e:
            logger.error(f"Places API request error: {e}")
            return []

    async def close(self):
        """リソース解放"""
        self._running = False
        self._gemini_session = None
