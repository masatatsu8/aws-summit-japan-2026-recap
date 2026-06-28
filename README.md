# aws-summit-japan-2026-recap

AWS Summit Japan 2026 のオンデマンドセッション (公開字幕) を自分の環境にダウンロードし、
AI で要約・引用付き検索できるようにする、**非公式の個人プロジェクト** のためのスクリプトと閲覧アプリ。

---

## ⚠ Disclaimer (必ずお読みください)

- **これは非公式 (unofficial / non-affiliated) なツールです。** Amazon Web Services, Inc. および Amazon.com, Inc. と無関係です。
- スクリプトが取得する VTT / PDF / メタデータ、およびそこから生成される要約はすべて
  **© Amazon Web Services / 各セッションスピーカー / 各社** の知的財産です。
  本リポジトリは **そのコンテンツを一切同梱しません**。
- 本ツールを実行する前に **AWS Summit Japan 2026 の利用規約を確認し、自己責任で実行** してください。
- 生成された要約は AI による派生物であり、**個人学習を超える再配布は想定していません**。
- **公開サーバとしてデプロイしないでください。** sidecar はローカル個人利用前提です。
- 本ツール作者は生成データの正確性・完全性について保証しません。
- 保守は **best-effort** です。Issue / PR は歓迎しますが、対応を保証するものではありません。
- "AWS"、"AWS Summit"、"Amazon Web Services" は Amazon.com, Inc. またはその関連会社の商標です。

---

## What you get / What you don't get

このリポジトリに **含まれるもの**:

- データ取得スクリプト (`scripts/download.mjs` 他): 公開エンドポイントから VTT / PDF を取得
- 要約生成スクリプト (`scripts/summarize.mjs`): Anthropic API で字幕を要約
- セットアップオーケストレータ (`scripts/setup.mjs`): 4 ステップを対話実行
- 閲覧用 Web アプリ (`app/`): React + Vite。検索・引用クリックで頭出し再生・AI Q&A
- スキーマ・プロンプト (`schema/`, `scripts/summarize-prompt.mjs`): 出力フォーマット定義 + 架空のサンプル

このリポジトリに **含まれないもの**:

- セッションカタログ (`data/catalog.json`) — 利用者が `npm run setup` で生成
- 字幕 VTT・文字起こし (`data/vtt/`, `data/transcripts/`) — 同上
- スライド PDF (`data/slides/`) — 同上
- 要約 JSON (`data/summaries/`) — Anthropic API キーで利用者が生成
- アプリ用の集約 JSON (`app/src/data/app-data.json`) — 上記から自動構築

---

## 必要なもの

- **Node.js 22 以上** (ESM + better-sqlite3 互換性のため)
- **ディスク 800MB 以上** (スライド PDF 含む全データ取得時)
- **Anthropic API キー** ([console.anthropic.com](https://console.anthropic.com/settings/keys) から取得)
  - sidecar の AI 検索と要約生成の両方で使う
  - 別途 Claude Code サブスクリプションで動かす方法もあります → [docs/CLAUDE-CODE-WORKFLOW.md](docs/CLAUDE-CODE-WORKFLOW.md)
- **推定コスト** (要約生成 1 回): `claude-sonnet-4-6` で **約 $5-15 USD** (133 セッション分。実コストは `npm run setup` 内の dry-run で表示)

---

## クイックスタート

```bash
# 1. クローン + 依存インストール
git clone https://github.com/masatatsu8/aws-summit-japan-2026-recap.git
cd aws-summit-japan-2026-recap
npm install

# 2. 環境変数を設定
cp .env.example .env
$EDITOR .env       # ANTHROPIC_API_KEY を埋める

# 3. データ取得 + 要約生成 (対話確認しながら 4 ステップ)
npm run setup

# 4. アプリ起動
cd app
npm install
npm run dev        # http://localhost:5173 を開く
```

各ステップ実行前に「何が起きるか / 推定コスト / 所要時間」が表示され、
y/N/skip で個別に確認できます。

**非対話モード** (CI 等):

```bash
node scripts/setup.mjs --yes               # 全部 yes
node scripts/setup.mjs --yes --skip-slides # スライド DL だけスキップ
```

---

## 詳細手順

`npm run setup` の各ステップを手動で実行したい / トラブル時の対処は
[**docs/REPRODUCING.md**](docs/REPRODUCING.md) を参照してください。

Claude Code サブスクリプションで要約生成する代替ルートは
[**docs/CLAUDE-CODE-WORKFLOW.md**](docs/CLAUDE-CODE-WORKFLOW.md) を参照してください。

アプリ構成は [**docs/ARCHITECTURE.md**](docs/ARCHITECTURE.md) を参照してください。

---

## 既知の限界

- **基調講演 / スペシャルセッション** など一部セッションは v2 の HLS / 字幕プレイリストが
  403 で、 v1 (音声差し替えのみ・字幕なし) として公開されています。
  `scripts/download.mjs` は v1 に自動フォールバックし、 `data/catalog.json` の
  `status` を `"captions-unavailable"` にして区別します。
  これらのセッションは視聴のみ可能、 文字起こし・要約は生成されません。
- **スピーカー名** はオンデマンドプレイヤー側の要ログイン情報のため、本リポジトリでは取得しません
- **要約品質** は自動字幕の認識精度に強く依存します。固有名詞は LLM 側でも補正していますが完璧ではありません
- **アプリは個人利用前提** です。CORS は `http://localhost:5173` のみ許可、SQLite はローカルファイルです

---

## ライセンス

Apache License 2.0 — [LICENSE](LICENSE) を参照。商標通知は [NOTICE](NOTICE) を参照。

## Contributing

best-effort 保守のため、まずは **Issue で相談** していただけると助かります。
小さな修正の PR は歓迎します。
