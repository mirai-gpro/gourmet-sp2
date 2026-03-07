# グルメサポートAI - Astro統合版

LLMを利用したグルメサポートサービスのフロントエンドをAstroに統合したプロジェクトです。

## 構成

```
gourmet-support/
├── src/
│   ├── components/
│   │   ├── GourmetChat.astro    # チャットUIコンポーネント
│   │   └── ProposalCard.astro   # レストラン提案カード
│   └── pages/
│       ├── index.astro          # メインページ（チャット＋提案）
│       └── chat.astro           # チャットのみページ
├── astro.config.mjs
├── package.json
└── .env.example
```

## 機能

### GourmetChat コンポーネント
- 💬 テキストチャット
- 🎤 音声入力（Google Cloud STT）
- 🔊 音声読み上げ（Google Cloud TTS）
- 📋 会話要約生成

### ProposalCard コンポーネント
- 📸 ヒーロー画像表示
- ⭐ 評価・レビュー数
- 💰 価格帯
- ✨ おすすめポイント
- 🔗 外部リンク（ホットペッパー、Google Maps、食べログ）

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. 環境変数の設定

```bash
cp .env.example .env
```

`.env` ファイルを編集してAPIエンドポイントを設定：

```env
# ローカル開発時（Flask同一オリジン）
PUBLIC_API_URL=

# 本番環境（Cloud Run）
PUBLIC_API_URL=https://your-service-xxxxx-an.a.run.app
```

### 3. 開発サーバー起動

```bash
npm run dev
```

http://localhost:4321 でアクセスできます。

## バックエンドとの統合

### ローカル開発

Flask（app_customer_support.py）とAstroを同時に起動します：

1. Flaskサーバー起動（8080ポート）：
```bash
python app_customer_support.py
```

2. Astro開発サーバー起動（4321ポート）：
```bash
npm run dev
```

CORSが設定されているため、異なるポート間での通信が可能です。

### Cloud Run デプロイ

#### 方法1: 静的ファイルとしてデプロイ

1. Astroをビルド：
```bash
npm run build
```

2. `dist/` フォルダをFlaskの `templates/` または `static/` に配置

3. Cloud Runにデプロイ

#### 方法2: Firebase Hostingと組み合わせ

1. Astroをビルド：
```bash
npm run build
```

2. Firebase Hostingにデプロイ：
```bash
firebase deploy --only hosting
```

3. Cloud Run APIは別途デプロイ

## APIエンドポイント

バックエンド（app_customer_support.py）が提供するAPI：

- `POST /api/session/start` - セッション開始
- `POST /api/chat` - チャットメッセージ送信
- `POST /api/finalize` - 会話終了・要約生成
- `POST /api/tts/synthesize` - テキスト→音声変換
- `POST /api/stt/transcribe` - 音声→テキスト変換

## カスタマイズ

### 提案カードのデータ

`index.astro` の `proposal` オブジェクトを編集するか、APIから動的に取得：

```astro
---
// APIから提案データを取得する例
const response = await fetch(`${apiBaseUrl}/api/proposal/${sessionId}`);
const proposal = await response.json();
---
```

### スタイルのカスタマイズ

各コンポーネント内の `<style>` タグを編集してデザインを変更できます。

### チャットと提案カードの連携

`GourmetChat` コンポーネントから提案を表示するイベントを発行：

```typescript
// チャット内でレストランが決まったら
const event = new CustomEvent('showProposal', {
  detail: { proposal: proposalData }
});
document.dispatchEvent(event);
```

## 注意事項

- 音声機能はHTTPS環境でのみ動作します（localostは除く）
- ブラウザによってはマイクの権限許可が必要です
- 初回音声再生にはユーザーインタラクションが必要です

## ライセンス

MIT
