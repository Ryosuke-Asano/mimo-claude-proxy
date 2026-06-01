# Xiaomi MiMo Claude Proxy

Claude Desktop / Claude Code で Xiaomi MiMo モデルを利用するためのプロキシ。Web UI 搭載。

Claude Desktop の Claude Code 機能は Claude 系モデル名（`claude-sonnet-4-6` 等）のみを受け付ける仕様がありますが、このプロキシが **モデル名を透過的に MiMo にマッピング** することで、Xiaomi MiMo モデルを Claude Code から利用できます。

> **Note:** Claude Code CLI の場合はプロキシ不要です。MiMo はネイティブで Anthropic 互換 API を提供しているため、`ANTHROPIC_BASE_URL` に直接設定できます。このプロキシは **Claude Desktop のモデル名制限** を回避するために必要です。

## 機能

- **Web UI** — ブラウザから API Key、プラン、リージョン、モデルマッピングを設定
- **マルチキーフォールバック** — 401/403/429 時に次の API Key を自動試行
- **Token Plan / 従量課金** 対応
- **3リージョン** — 中国 / シンガポール / ヨーロッパ
- **SSE ストリーミング** 対応（モデル名書き換え付き）
- **PM2 管理** 前提設計
- **ゼロ依存** — Node.js 標準モジュールのみ

## 仕組み

```text
Claude Desktop
       │
       │  Anthropic Messages API (model: claude-sonnet-4-6)
       ▼
  proxy.mjs (:3335)
       │  ┌ model: claude-sonnet-4-6 → mimo-v2.5-pro
       │  └ response: mimo-v2.5-pro → claude-sonnet-4-6
       ▼
  MiMo Anthropic 互換エンドポイント
```

## 必要要件

- Node.js 18+
- Xiaomi MiMo API キー（[platform.xiaomimimo.com](https://platform.xiaomimimo.com) で取得）
- MiMo Token Plan サブスクリプション または 従量課金残高

## クイックスタート

```bash
# 1. 起動
node proxy.mjs

# 2. ブラウザで Web UI を開く
open http://localhost:3335

# 3. API Key を入力して Save
```

## PM2 で管理

```bash
# 起動
pm2 start ecosystem.config.cjs

# 状態確認
pm2 status mimo-claude-proxy

# ログ確認
pm2 logs mimo-claude-proxy

# 再起動
pm2 restart mimo-claude-proxy

# 停止
pm2 stop mimo-claude-proxy

# OS 起動時に自動起動
pm2 save
pm2 startup
```

## Web UI

`http://localhost:3335` にアクセスすると、以下の設定がブラウザから行えます：

- **API Keys** — 複数キーの追加/削除（フォールバック順）
- **Plan** — Token Plan（サブスクリプション）または Pay-per-use（従量課金）
- **Region** — 中国 / シンガポール / ヨーロッパ
- **Model Mapping** — Opus / Sonnet / Haiku をどの MiMo モデルにマッピングするか

設定は `~/.mimo-proxy/config.json` に保存され、即座に反映されます（再起動不要）。

## MiMo API エンドポイント一覧

### Token Plan（サブスクリプション） — API Key: `tp-xxxxx`

| プロトコル | 中国（CN） | シンガポール（SGP） | ヨーロッパ（AMS） |
|-----------|-----------|-------------------|------------------|
| Anthropic 互換 | `token-plan-cn.xiaomimimo.com/anthropic` | `token-plan-sgp.xiaomimimo.com/anthropic` | `token-plan-ams.xiaomimimo.com/anthropic` |
| OpenAI 互換 | `token-plan-cn.xiaomimimo.com/v1` | `token-plan-sgp.xiaomimimo.com/v1` | `token-plan-ams.xiaomimimo.com/v1` |

### 従量課金（Pay-per-use） — API Key: `sk-xxxxx`

| プロトコル | Base URL |
|-----------|----------|
| OpenAI 互換 | `api.xiaomimimo.com/v1` |

> **Warning:** Token Plan の API Key (`tp-xxxxx`) と従量課金の API Key (`sk-xxxxx`) は互換性がありません。

## Claude Desktop の設定

```text
inferenceGatewayBaseUrl: http://localhost:3335/anthropic/
inferenceGatewayApiKey:  <MiMo API key (tp-xxxxx)>
```

## Claude Code の設定

`~/.claude/settings.json` に以下を追加:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3335",
    "ANTHROPIC_AUTH_TOKEN": "<MiMo API key>"
  }
}
```

## モデルマッピング

デフォルトのマッピング:

| Claude モデル名 | MiMo モデル | 説明 |
|---|---|---|
| `claude-opus-4-8` | `mimo-v2.5-pro` | 最新フラッグシップ |
| `claude-opus-4-7` | `mimo-v2.5-pro` | 最新フラッグシップ |
| `claude-opus-4-6` | `mimo-v2.5-pro` | 最新フラッグシップ |
| `claude-sonnet-4-7` | `mimo-v2.5-pro` | 最新フラッグシップ |
| `claude-sonnet-4-6` | `mimo-v2.5-pro` | 最新フラッグシップ |
| `claude-sonnet-4-5-20250929` | `mimo-v2-pro` | 前世代フラッグシップ |
| `claude-haiku-4-5-20251001` | `mimo-v2-flash` | 軽量高速モデル |

Web UI または `~/.mimo-proxy/config.json` で変更可能。

## 環境変数

| 変数名 | デフォルト | 説明 |
|---|---|---|
| `MIMO_PROXY_PORT` | `3335` | リッスンポート |
| `MIMO_API_KEY` | *(なし)* | API Key（環境変数経由、config より優先） |
| `MIMO_API_URL` | *(自動生成)* | 上流 API URL の完全上書き |

## 設定ファイル

```text
~/.mimo-proxy/
  ├── config.json   # Web UI から保存される設定
  └── proxy.log     # リクエストログ
```

## zai-claude-proxy との共存

ポート `3335` を使用するため、`zai-claude-proxy`（ポート `3333`）と同時に稼働できます。

## エンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| `GET` | `/` | Web UI |
| `GET` | `/api/config` | 設定取得（JSON） |
| `POST` | `/api/config` | 設定保存（JSON） |
| `GET` | `/health` | ヘルスチェック |
| `GET` | `/v1/models` | モデル一覧 |
| `POST` | `/v1/messages` | Anthropic Messages API |
