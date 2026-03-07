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

## 大前提: フロントエンドからのAPI呼び出し方式

**フロントエンドからバックエンドへの直接REST呼び出しは行わない。**

| 通信種別 | 接続先 | 方式 |
|---|---|---|
| HTTP（fetch） | same-origin（`apiBase=''`） | Vercel rewrites 経由でバックエンドにプロキシ |
| Socket.IO（WebSocket） | `https://support-base-hhasiuut7q-uc.a.run.app` | Vercel プロキシ非対応のため直接接続 |

- `apiBase`（HTTP fetch用）と `backendUrl`（Socket.IO用）は**別々に管理**する
- `apiBase` は常に `''`（same-origin）
- `backendUrl` は Socket.IO 接続専用

---

## 変更対象ファイル一覧

| ファイル | 変更種別 |
|---|---|
| `src/scripts/chat/core-controller.ts` | 修正（APIパスのみ） |
| `src/scripts/chat/concierge-controller.ts` | 修正（APIパス + initSocket接続先分離） |
| `src/components/Concierge.astro` | 修正（props追加 + apiBase/backendUrl分離） |
| `src/components/GourmetChat.astro` | 修正（apiBase/backendUrl分離） |
| `src/pages/concierge.astro` | 修正（backendUrl追加） |
| `src/pages/index.astro` | 修正（backendUrl追加） |

---

## 1. エンドポイントパス変更一覧

### HTTP エンドポイント（Vercel rewrites 経由）

| v1（変更前） | v2（変更後） | 用途 |
|---|---|---|
| `/api/chat` | `/api/v2/rest/chat` | チャットメッセージ送信 |
| `/api/tts/synthesize` | `/api/v2/rest/tts/synthesize` | TTS音声合成 |
| `/api/cancel` | `/api/v2/rest/cancel` | リクエストキャンセル |
| `/api/session/start` | `/api/v2/session/start` | セッション開始 |
| `/api/session/end` | `/api/v2/session/end` | セッション終了 |

全て `apiBase=''`（same-origin）経由。フロントエンドからバックエンドへの直接fetch呼び出しはしない。

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

**変更内容:** APIパス文字列の置換 + `initSocket()` の接続先分離。

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

#### `initSocket()` の接続先分離

**変更前（②）:**
```typescript
this.socket = io(this.apiBase || window.location.origin);
```
`this.apiBase` が `backendUrl` と混同されていた。

**変更後（③）:**
```typescript
const backendUrl = this.container.dataset.backendUrl || window.location.origin;
this.socket = io(backendUrl);
```
Socket.IO は `data-backend-url` から取得した値で直接接続。HTTP fetch は `this.apiBase=''` のまま。

### 2.3 `Concierge.astro`

**変更内容:**

| 箇所 | 変更内容 |
|---|---|
| Props | `backendUrl?: string` 追加（デフォルト `''`） |
| HTML | `data-backend-url={backendUrl}` 属性追加 |
| Script | `apiBase` と `backendUrl` を分離（後述） |

#### apiBase / backendUrl 分離

**変更前（②）:**
```typescript
const apiBase = container.dataset.apiBase || '';
new ConciergeController(container, apiBase);
```

**変更後（③）:**
```typescript
const apiBase = container.dataset.apiBase || '';
new ConciergeController(container, apiBase);
```
`apiBase` は常に `''`（same-origin）。`backendUrl` はコントローラ内で `container.dataset.backendUrl` から直接取得。

### 2.4 `GourmetChat.astro`

**変更内容:** Concierge.astro と同様に `apiBase` / `backendUrl` を分離。

**変更前:**
```typescript
const apiBase = container.dataset.backendUrl || container.dataset.apiBase || '';
```

**変更後:**
```typescript
const apiBase = container.dataset.apiBase || '';
```

### 2.5 `concierge.astro`（ページ）

**変更内容:**

| 箇所 | 変更前 | 変更後 |
|---|---|---|
| `apiBaseUrl` | `import.meta.env.PUBLIC_API_URL \|\| ''` | `''`（固定） |
| `backendUrl` | なし | `'https://support-base-hhasiuut7q-uc.a.run.app'`（新規追加） |
| Component | `<ConciergeComponent apiBaseUrl={apiBaseUrl} />` | `<ConciergeComponent apiBaseUrl={apiBaseUrl} backendUrl={backendUrl} />` |

### 2.6 `index.astro`（ページ）

concierge.astro と同様。`backendUrl` を追加し、コンポーネントに渡す。

---

## 3. 接続方式の整理

| 通信種別 | apiBase / backendUrl | 接続先 | プロキシ |
|---|---|---|---|
| HTTP fetch | `apiBase=''` | same-origin | Vercel rewrites 経由 |
| Socket.IO | `data-backend-url` | `https://support-base-hhasiuut7q-uc.a.run.app` | 直接接続（プロキシなし） |

### 重要: apiBase と backendUrl の分離
- `apiBase`（コントローラの `this.apiBase`）: HTTP fetch 専用。常に `''`（same-origin）
- `backendUrl`（`data-backend-url` 属性）: Socket.IO 専用。コントローラの `initSocket()` 内で `this.container.dataset.backendUrl` から取得

**フロントエンドからバックエンドへの直接REST呼び出しは行わない。**

---

## 4. ロジック変更

`initSocket()` の接続先を `this.apiBase` から `this.container.dataset.backendUrl` に変更。
それ以外はAPIパス文字列の置換のみ。
