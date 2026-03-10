# LiveAPI トラブルシューティング手順

## 前提: 5904ae5 のコードに論理的バグはない

コード分析の結果、LiveAPI WebSocket対応のフロントエンド・バックエンド共に正しく実装されている。
問題はデプロイ状態またはキャッシュに起因する可能性が高い。

---

## Step 1: ブラウザの PWA Service Worker キャッシュをクリア

**最有力原因**: PWA Service Worker が古いJS（LiveAPI非対応版）をキャッシュしている。

### 手順
1. Chrome DevTools → **Application** タブ
2. 左メニュー → **Service Workers**
3. 「Unregister」をクリック
4. 左メニュー → **Cache Storage** → 全てのキャッシュを右クリック → 削除
5. 左メニュー → **Storage** → 「Clear site data」ボタン
6. ページをハードリロード（Ctrl+Shift+R / Cmd+Shift+R）

### 確認ポイント
コンソールに以下が表示されるか確認:
```
[Core] Starting initialization... (build=5904ae5-live, ts=2026-03-08)
```
- `build=5904ae5-live` が出る → フロントエンドは最新版。Step 2 へ
- `build=` が出ない or `[Core] Starting initialization...` のみ → フロントエンドが古い。Step 3 へ

---

## Step 2: バックエンド WebSocket エンドポイント確認

### 2-1. ヘルスチェック
```bash
curl https://[BACKEND_URL]/health | python -m json.tool
```

確認項目:
- `build_version` が `5904ae5-live` であること
- `live_api` が `ok` であること
- `flask_sock` が `ok` であること

### 2-2. WebSocket接続テスト
```bash
# wscat がなければ: npm install -g wscat
wscat -c wss://[BACKEND_URL]/ws/live/test-session-id
```

- 接続できる → バックエンドOK
- 接続拒否 → Cloud Run のWebSocket設定を確認（Step 4）

### 2-3. Cloud Run ログ確認
```bash
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=[SERVICE_NAME]" \
  --limit=50 --format="table(timestamp,textPayload)"
```

`[LiveAPI WS] ★ WebSocket接続受信` が出ているか確認。

---

## Step 3: フロントエンド（Vercel）の再デプロイ

### 3-1. 現在のVercelデプロイバージョン確認
Vercel ダッシュボード → プロジェクト → Deployments で最新デプロイのコミットハッシュ確認。

### 3-2. 強制再デプロイ
```bash
# 方法A: git push で自動デプロイ（推奨）
git push origin main

# 方法B: Vercel CLI
vercel --prod
```

### 3-3. デプロイ後の確認
1. Service Worker キャッシュをクリア（Step 1）
2. コンソールで `build=5904ae5-live` を確認
3. コンソールで `[Core] initLiveConnection called` を確認
4. コンソールで `[LiveWS] Connecting...` を確認

---

## Step 4: Cloud Run バックエンドの再デプロイ

### 4-1. ビルド＆デプロイ
```bash
cd support-base
gcloud builds submit --tag gcr.io/[PROJECT_ID]/[SERVICE_NAME]
gcloud run deploy [SERVICE_NAME] \
  --image gcr.io/[PROJECT_ID]/[SERVICE_NAME] \
  --region [REGION] \
  --allow-unauthenticated \
  --port 8080 \
  --timeout 300 \
  --min-instances 1
```

### 4-2. WebSocket対応確認（Cloud Run設定）
Cloud Run はWebSocket対応済みだが、以下を確認:
- **Session affinity**: 不要（flask-sockは単一リクエスト内で完結）
- **Timeout**: 300秒以上推奨（WebSocketの長時間接続のため）
- **Concurrency**: 1以上（デフォルト80で問題なし）

---

## Step 5: コンソールログの読み方

### 正常な初期化シーケンス（期待値）
```
[Core] Starting initialization... (build=5904ae5-live, ts=2026-03-08)
[Core] Updating UI language to: ja
[Core] initLiveConnection called: sessionId=xxx, apiBase=https://...
[Core] LiveWebSocket created and connect() called
[LiveWS] Connecting... (attempt 1)
[LiveWS] Connected
[LiveAPI] Ready
[Core] Initialization completed
```

### 異常パターンと対処

| コンソール出力 | 原因 | 対処 |
|---|---|---|
| `build=` が出ない | フロントが古い版 | Step 1 → Step 3 |
| `initLiveConnection called` が出ない | initializeSession内でエラー | `[Session] Initialization error:` を確認 |
| `[LiveWS] Connecting...` の後に何も出ない | WebSocket接続タイムアウト | Step 2 でバックエンド確認 |
| `[LiveWS] Closed: code=...` | WebSocket切断 | code値を確認（1006=ネットワーク, 1011=サーバーエラー）|
| `[LiveWS] Error:` | WebSocket接続エラー | バックエンドURL/CORS確認 |

---

## 補足: live_session.py がコンテナに存在する証拠

`app_customer_support.py` の44行目:
```python
from live_session import LiveSessionManager
```
これはトップレベルインポート。`live_session.py` が欠如していれば `ImportError` で
Flask アプリ全体が起動失敗し、REST API も動作しない。
REST API が正常動作している = `live_session.py` はコンテナ内に存在する。

ビルドステップ数の差異（13命令 vs 12ステップ）は、
`EXPOSE 8080` がBuildKitで独立ステップとしてカウントされないことが原因。
