# 仕様変更書③: REST API v1 → v2 エンドポイント移行

## 基準ソース
- 変更前: [LAM_gpro/gourmet-sp](https://github.com/mirai-gpro/LAM_gpro/tree/claude/fix-modelscope-wheels-mpGPD/gourmet-sp)（②アバターパッチ）
- 変更後: gourmet-sp2（③本リポジトリ）

---

## 変更目的
バックエンドの REST API エンドポイントが v1 から v2 に変更されたことに伴い、フロントエンドの全APIリクエストパスを更新する。

---

## 背景: バックエンドの変更
バックエンド（`support-base-hhasiuut7q-uc.a.run.app`）が以下のように変更された:
- REST API のみ対応 → **Live API（v2）対応に修正**
- エンドポイントパスの体系が `/api/xxx` → `/api/v2/rest/xxx` および `/api/v2/session/xxx` に変更

---

## 変更対象ファイル一覧

| ファイル | 変更種別 |
|---|---|
| `src/scripts/chat/core-controller.ts` | 修正（APIパスのみ） |
| `src/scripts/chat/concierge-controller.ts` | 修正（APIパスのみ） |
| `src/components/Concierge.astro` | 修正（props追加 + 接続先変更） |
| `src/pages/concierge.astro` | 修正（接続先URL変更） |

---

## 1. エンドポイントパス変更一覧

### REST API エンドポイント

| v1（変更前） | v2（変更後） | 用途 |
|---|---|---|
| `/api/chat` | `/api/v2/rest/chat` | チャットメッセージ送信 |
| `/api/tts/synthesize` | `/api/v2/rest/tts/synthesize` | TTS音声合成 |
| `/api/cancel` | `/api/v2/rest/cancel` | リクエストキャンセル |

### セッション管理エンドポイント

| v1（変更前） | v2（変更後） | 用途 |
|---|---|---|
| `/api/session/start` | `/api/v2/session/start` | セッション開始 |
| `/api/session/end` | `/api/v2/session/end` | セッション終了 |

---

## 2. ファイル別変更詳細

### 2.1 `core-controller.ts`

**変更内容:** APIパス文字列の置換のみ。ロジック変更なし。

| 箇所（メソッド） | 変更前 | 変更後 |
|---|---|---|
| `cancelPendingRequest()` | `/api/cancel` | `/api/v2/rest/cancel` |
| `cleanupSession()` | `/api/session/end` | `/api/v2/session/end` |
| `initializeSession()` | `/api/session/start` | `/api/v2/session/start` |
| `initializeSession()` (ack TTS) | `/api/tts/synthesize` | `/api/v2/rest/tts/synthesize` |
| `cancelPendingRequest()` (2箇所目) | `/api/cancel` | `/api/v2/rest/cancel` |
| `sendMessage()` | `/api/chat` | `/api/v2/rest/chat` |
| `speakResponseInChunks()` (2箇所) | `/api/tts/synthesize` | `/api/v2/rest/tts/synthesize` |
| `speakTextGCP()` | `/api/tts/synthesize` | `/api/v2/rest/tts/synthesize` |
| `handleUserCancel()` | `/api/cancel` | `/api/v2/rest/cancel` |

合計: **11箇所**のパス置換

### 2.2 `concierge-controller.ts`

**変更内容:** APIパス文字列の置換のみ。ロジック変更なし。

| 箇所（メソッド） | 変更前 | 変更後 |
|---|---|---|
| `cleanupSession()` | `/api/session/end` | `/api/v2/session/end` |
| `initializeSession()` | `/api/session/start` | `/api/v2/session/start` |
| `initializeSession()` (ack TTS) | `/api/tts/synthesize` | `/api/v2/rest/tts/synthesize` |
| `speakTextGCP()` | `/api/tts/synthesize` | `/api/v2/rest/tts/synthesize` |
| `speakResponseInChunks()` (2箇所) | `/api/tts/synthesize` | `/api/v2/rest/tts/synthesize` |
| `sendMessage()` | `/api/chat` | `/api/v2/rest/chat` |
| `speakResponseInChunks()` (ショップ用2箇所) | `/api/tts/synthesize` | `/api/v2/rest/tts/synthesize` |

合計: **10箇所**のパス置換

### 2.3 `Concierge.astro`

**変更内容:**

| 箇所 | 変更内容 |
|---|---|
| Props | `backendUrl?: string` 追加（デフォルト `''`） |
| HTML | `data-backend-url={backendUrl}` 属性追加 |
| Script | `apiBase` 取得ロジック変更（後述） |

#### apiBase 取得ロジック変更

**変更前（②）:**
```typescript
const apiBase = container.dataset.apiBase || '';
```

**変更後（③）:**
```typescript
const apiBase = container.dataset.backendUrl || container.dataset.apiBase || '';
```

**理由:** Vercel プロキシ経由では REST API は same-origin（`apiBase=''`）で動作するが、Socket.IO は Vercel プロキシ非対応のためバックエンドに直接接続する必要がある。`backendUrl` で直接接続先を指定可能にした。

### 2.4 `concierge.astro`（ページ）

**変更内容:**

| 箇所 | 変更前 | 変更後 |
|---|---|---|
| `apiBaseUrl` | `import.meta.env.PUBLIC_API_URL \|\| ''` | `''`（固定） |
| `backendUrl` | なし | `'https://support-base-hhasiuut7q-uc.a.run.app'`（新規追加） |
| Component | `<ConciergeComponent apiBaseUrl={apiBaseUrl} />` | `<ConciergeComponent apiBaseUrl={apiBaseUrl} backendUrl={backendUrl} />` |

**理由:**
- REST API: Vercel rewrites で same-origin プロキシ経由 → `apiBaseUrl=''`
- Socket.IO: Vercel プロキシ非対応 → バックエンドに直接接続 → `backendUrl` で明示指定

---

## 3. 接続方式の整理

| 通信種別 | 接続先 | プロキシ |
|---|---|---|
| REST API（HTTP） | same-origin（`''`） | Vercel rewrites 経由 |
| Socket.IO（WebSocket） | `https://support-base-hhasiuut7q-uc.a.run.app` | 直接接続（プロキシなし） |

### Socket.IO 接続の仕組み
`concierge-controller.ts` の `initSocket()` で `io(this.apiBase)` を呼び出す。
`this.apiBase` は `container.dataset.backendUrl` から取得されるため、Socket.IO はバックエンドに直接接続される。

---

## 4. ロジック変更

**なし。** 全変更はAPIパス文字列の置換と接続先URLの設定変更のみ。
