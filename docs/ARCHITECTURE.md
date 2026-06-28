# アーキテクチャ

## 全体図

```
┌─────────────────────────────────────────────────────────────────┐
│                     利用者のローカルマシン                       │
│                                                                 │
│  ┌─────────────┐   ┌──────────────────┐   ┌─────────────────┐   │
│  │  Vite dev   │   │  React アプリ    │   │   Anthropic     │   │
│  │  (5173)     │←─→│  (app/src)       │←──│   API key       │   │
│  └─────────────┘   └────────┬─────────┘   │   (利用者環境変数)│  │
│                             │              └─────────────────┘  │
│                             ↓ fetch (CORS allowlist)            │
│                    ┌──────────────────┐    ┌─────────────────┐  │
│                    │  sidecar (3001)  │←──→│  Anthropic API  │  │
│                    │  app/server/     │    │  or Claude SDK  │  │
│                    │  sidecar.mjs     │    └─────────────────┘  │
│                    └────────┬─────────┘                         │
│                             ↓                                   │
│                    ┌──────────────────┐                         │
│                    │  better-sqlite3  │  data/bookmarks.db      │
│                    │  bookmarks/lists/│                         │
│                    │  chats/screenshots│                        │
│                    └──────────────────┘                         │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  data/ (npm run setup で生成、リポジトリ未管理)          │   │
│  │  ├─ catalog.json        ← AWS の公開 events.json から    │   │
│  │  ├─ vtt/*, transcripts/* ← AWS の公開 CloudFront から    │   │
│  │  ├─ slides/*.pdf        ← AWS Cloud の配布ページから     │   │
│  │  ├─ summaries/*.json    ← Anthropic API で要約          │   │
│  │  └─ screenshots/*.png   ← アプリで撮影                  │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## データフロー (npm run setup の 4 ステップ)

1. **`scripts/download.mjs`** — AWS 公開 CMS (`site-assets.corrivium.live/.../events.json`) から
   セッションメタを取り、CloudFront 上の HLS マスター (`dz2ooo85w8eqv.cloudfront.net/...`) から
   字幕プレイリストを辿って VTT を取得。タイムスタンプ付きテキストに整形して
   `data/transcripts/{slug}.{ja,en}.txt` に保存。

2. **`scripts/fetch-slide-urls.mjs` + `scripts/download-and-extract-slides.mjs`** —
   `pages.awscloud.com/AWS-Summit-Japan-2026-Session-Materials-Download.html` から
   PDF 配布リンクを抽出し、`data/slides/*.pdf` にダウンロード。
   `pdf-parse` で本文テキストを抽出し、ページマーカー (`[p1]`, `[p2]`, ...) 付きで
   `data/slides_text/*.txt` に保存。

3. **`scripts/summarize.mjs`** — `data/transcripts/{slug}.ja.txt` を Anthropic Messages API
   (`claude-sonnet-4-6` 既定) で要約。`scripts/summarize-prompt.mjs` の架空サンプルを
   システムプロンプトに含めることでフォーマットを誘導。並列度 4 + 指数バックオフリトライ +
   レジューム機構を持ち、`data/summaries/{slug}.json` に保存。

4. **`app/scripts/build-index.mjs`** — `data/catalog.json` + `data/summaries/*` を
   `app/src/data/app-data.json` に集約。`data/slides_text/*` を `app/src/data/slides-text.json`
   に集約。Vite ビルド時にバンドルされる。

## sidecar の役割

`app/server/sidecar.mjs` はローカル個人利用前提の Node.js HTTP サーバで、以下を担う:

- **AI Q&A** (`POST /api/chats/:id/ask`) — 全セッションの tldr + keyPoints をシステムプロンプトに
  埋め込み、Anthropic Messages API または Claude Agent SDK でストリーミング応答。
  「全件知識モード」(参照されたセッションのみ citations を動的展開) と
  「エージェント検索モード」(全文検索上位 8 件の citations を全展開) の 2 モードを切替。
- **ブックマーク / リスト / スクショ管理** — better-sqlite3 で `data/bookmarks.db` に保存。
- **スライド PDF 配信** (`GET /api/slides/:slug.pdf`) — `data/slides/*.pdf` を proxy。
  slug は厳格な正規表現 (`^[a-zA-Z0-9_-]{1,64}$`) + path traversal 防御。

### セキュリティ前提

- **CORS allowlist**: `http://localhost:5173` (Vite dev server) のみ許可。
  `ALLOWED_ORIGINS` 環境変数で拡張可。
- **CSRF 防御**: 変更系メソッド (POST/PATCH/DELETE) は Origin/Referer を allowlist で検証。
- **Path traversal 防御**: `safeResolve()` ヘルパで `data/slides/` と `data/screenshots/` から逸脱不可。
- **Agent SDK の fail-closed**: `allowedTools: []` (空 allowlist) + `permissionMode: 'default'`。
  SDK 更新で新ツールが追加されても自動的に拒否される。

## なぜ Claude Agent SDK と Anthropic API の両方をサポートするか

- **Anthropic API** (`LLM_BACKEND=api`、デフォルト) — Claude Code がインストールされていない
  利用者でも使える、コストが透明、CI 自動化しやすい。
- **Claude Agent SDK** (`LLM_BACKEND=agent`) — Claude Code のサブスクリプションで定額利用、
  本人 PC でのみ動作。

両者はインタフェース (`runAnthropicApi` / `runAgentSdk`) を揃え、上位の Q&A ロジックから
バックエンドを差し替えるだけで切替可能。

## 主要ディレクトリ

```
.
├── README.md
├── LICENSE / NOTICE
├── docs/
│   ├── ARCHITECTURE.md            ← 本書
│   ├── REPRODUCING.md             ← データ生成手順詳細
│   ├── CLAUDE-CODE-WORKFLOW.md    ← Claude Code 経由の代替ルート
│   └── notes/cors-check.md        ← CORS / HLS の実機検証メモ
├── schema/
│   └── summary.schema.json        ← 要約 JSON のスキーマ
├── scripts/
│   ├── setup.mjs                  ← オーケストレータ
│   ├── download.mjs               ← VTT + カタログ取得
│   ├── fetch-slide-urls.mjs       ← PDF URL 抽出
│   ├── download-and-extract-slides.mjs  ← PDF DL + テキスト抽出
│   ├── summarize.mjs              ← Anthropic API で要約
│   ├── summarize-prompt.mjs       ← プロンプトと架空サンプル
│   ├── validate-summaries.mjs     ← スキーマ検証
│   ├── audit-summaries.mjs        ← 整合性チェック
│   ├── sort-citations.mjs         ← citations 並び替え
│   └── finalize.mjs               ← sort → validate → build-index
└── app/
    ├── vite.config.ts / tsconfig.json
    ├── server/
    │   ├── sidecar.mjs            ← HTTP API + AI 応答
    │   └── db.mjs                 ← better-sqlite3 スキーマ
    ├── scripts/build-index.mjs    ← summaries → app-data.json
    └── src/
        ├── App.tsx / main.tsx / styles.css
        ├── pages/                 ← Browse, Ask, Session, Bookmarks 等
        ├── components/            ← Player, SlideModal, AddToListButton
        ├── lib/                   ← markdown, search, bookmarks, ...
        └── data/                  ← (build-index で生成、git 管理外)
```
