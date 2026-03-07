# バックエンド構造化レスポンス対応ガイド

LLMの応答をショップカードとして表示するために、バックエンドで構造化データを返す必要があります。

## 方法1: プロンプトでJSON形式を指定

`prompt_manager.py` のプロンプトを以下のように修正：

```python
# GCSの prompts/support_system.txt を以下のように修正

あなたはグルメサポートAIです。ユーザーの要望に応じてお店を提案します。

## レスポンス形式

お店を提案する場合は、必ず以下のJSON形式で構造化データを含めてください：

```json
{
  "message": "ユーザーへの応答メッセージ",
  "shops": [
    {
      "name": "店名",
      "category": "イタリアン",
      "description": "お店の説明",
      "rating": 3.5,
      "priceRange": "3000円〜5000円",
      "location": "恵比寿駅徒歩3分",
      "image": "https://...",
      "hotpepper_url": "https://...",
      "maps_url": "https://...",
      "tabelog_url": "https://..."
    }
  ]
}
```

お店を提案しない場合（質問への回答など）は shops を空配列にしてください。
```

## 方法2: app_customer_support.py を修正

`process_user_message` メソッドを修正してJSONパースを追加：

```python
def process_user_message(self, user_message, conversation_stage='conversation'):
    """ユーザーメッセージを処理"""
    # ... 既存のコード ...
    
    try:
        response = model.generate_content(prompt)
        assistant_text = response.text
        
        # JSON形式の応答をパース
        shops = []
        message = assistant_text
        
        try:
            # JSONブロックを抽出
            import re
            json_match = re.search(r'```json\s*(\{.*?\})\s*```', assistant_text, re.DOTALL)
            if json_match:
                data = json.loads(json_match.group(1))
                message = data.get('message', assistant_text)
                shops = data.get('shops', [])
            else:
                # 直接JSONの場合
                if assistant_text.strip().startswith('{'):
                    data = json.loads(assistant_text)
                    message = data.get('message', assistant_text)
                    shops = data.get('shops', [])
        except json.JSONDecodeError:
            # JSONでない場合はそのまま
            pass
        
        # 会話中の場合は要約を生成
        summary = None
        if conversation_stage == 'conversation':
            summary = self._generate_summary(user_message, message)
        
        return {
            'response': message,
            'summary': summary,
            'shops': shops,  # ショップデータを追加
            'should_confirm': conversation_stage == 'conversation'
        }
        
    except Exception as e:
        logger.error(f"[Assistant] Gemini APIエラー: {e}")
        return {
            'response': 'エラーが発生しました。もう一度お試しください。',
            'summary': None,
            'shops': [],
            'should_confirm': False
        }
```

## 方法3: 外部API連携（推奨）

実際の店舗データを取得するには、以下のAPIと連携：

### ホットペッパーAPI
```python
import requests

def search_restaurants(keyword, area):
    """ホットペッパーAPIで店舗検索"""
    api_key = os.getenv('HOTPEPPER_API_KEY')
    url = 'http://webservice.recruit.co.jp/hotpepper/gourmet/v1/'
    
    params = {
        'key': api_key,
        'keyword': keyword,
        'large_area': area,  # 例: 'Z011' (東京)
        'format': 'json',
        'count': 5
    }
    
    response = requests.get(url, params=params)
    data = response.json()
    
    shops = []
    for shop in data['results']['shop']:
        shops.append({
            'name': shop['name'],
            'category': shop['genre']['name'],
            'description': shop['catch'],
            'priceRange': shop['budget']['name'],
            'location': shop['access'],
            'image': shop['photo']['pc']['l'],
            'hotpepper_url': shop['urls']['pc'],
        })
    
    return shops
```

### Google Places API
```python
def search_google_places(query, location):
    """Google Places APIで店舗検索"""
    api_key = os.getenv('GOOGLE_PLACES_API_KEY')
    url = 'https://maps.googleapis.com/maps/api/place/textsearch/json'
    
    params = {
        'query': query,
        'location': location,  # 例: '35.6477,139.7102'
        'radius': 1000,
        'type': 'restaurant',
        'key': api_key,
        'language': 'ja'
    }
    
    response = requests.get(url, params=params)
    data = response.json()
    
    shops = []
    for place in data['results'][:5]:
        shops.append({
            'name': place['name'],
            'rating': place.get('rating'),
            'location': place.get('formatted_address'),
            'image': get_place_photo(place.get('photos', [{}])[0].get('photo_reference')),
            'maps_url': f"https://www.google.com/maps/place/?q=place_id:{place['place_id']}"
        })
    
    return shops
```

## チャットAPIの応答例

```json
{
  "response": "恵比寿でおすすめのイタリアンを5軒ご紹介します！",
  "summary": "恵比寿のイタリアンレストラン5軒を提案",
  "shops": [
    {
      "name": "Osteria Briccone",
      "category": "イタリアン",
      "description": "本格的なイタリア郷土料理が楽しめる人気店",
      "rating": 3.8,
      "priceRange": "5000円〜8000円",
      "location": "恵比寿駅徒歩5分",
      "image": "https://...",
      "hotpepper_url": "https://...",
      "maps_url": "https://...",
      "tabelog_url": "https://..."
    },
    // ... 他の店舗
  ],
  "should_confirm": true
}
```
