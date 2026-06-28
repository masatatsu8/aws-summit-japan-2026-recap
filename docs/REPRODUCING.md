# 再現手順 (詳細)

`npm run setup` の各ステップを個別に理解 / 手動実行 / トラブル対処したい人向け。

---

## 前提

- Node.js 22 以上
- `npm install` 済み (ルートと `app/` の両方で)
- `.env` に `ANTHROPIC_API_KEY` を設定 (要約生成のため)

---

## ステップ 1: セッションカタログ + 字幕 (VTT) ダウンロード

```bash
node scripts/download.mjs
# 一部だけ取得する場合: node scripts/download.mjs jpn-xxxNNN jpn-xxxMMM
```

**何が起きるか**:

1. 公開 CMS から `events.json` を取得 → 全 ~135 セッションのメタを `data/catalog.json` に保存
2. 各セッションの HLS マスター (`*/index.m3u8`) を取得して字幕トラックを検出
3. 字幕プレイリストの VTT セグメントを結合して `data/vtt/{slug}.{ja,en}.vtt` に保存
4. タイムスタンプ付きテキストを `data/transcripts/{slug}.{ja,en}.txt` に保存

**所要**: 3-5 分 (ネットワーク次第)
**サイズ**: VTT/transcripts 合計 ~22 MB
**認証**: 不要 (CloudFront 公開アセット)

**トラブル**:

- **基調講演などが `captions-unavailable` になる**: 一部の基調講演 / スペシャルセッションは
  v2 字幕プレイリストが 403、 v1 (音声差し替えのみ・字幕なし) のみ公開されている構成です。
  スクリプトは自動で v1 にフォールバックし、 `data/catalog.json` の `status` を
  `"captions-unavailable"` に、 `hlsMaster` を v1 URL に更新します。 これらのセッションは
  視聴は可能ですが文字起こし・要約は生成できません (字幕が存在しないため)。
- **完全に取れないセッション (`forbidden-403`)**: v2 も v1 も 403 のケース。
  公開タイミング差で後日再実行で取得できることがあります。
- **タイムアウト**: 並列度 6 で取得しています。回線が細い場合は時間を空けて再実行してください
  (既に取得済みの VTT は再利用されます)。

---

## ステップ 2: スライド PDF + テキスト抽出

```bash
node scripts/fetch-slide-urls.mjs
node scripts/download-and-extract-slides.mjs
```

**何が起きるか**:

1. `fetch-slide-urls.mjs` が AWS Cloud の公式配布ページから (sessionId → PDF URL) を抽出し
   `data/slides_urls.json` に保存
2. `download-and-extract-slides.mjs` が各 PDF を `data/slides/{slug}.pdf` にダウンロード
3. `pdf-parse` でテキストを抽出し、ページマーカー (`[p1]`, `[p2]`, ...) 付きで
   `data/slides_text/{slug}.txt` に保存

**所要**: 5-10 分
**サイズ**: ~700 MB ※ディスク容量を確認してください
**認証**: 不要

**トラブル**:

- **`pdf-parse` のエラー**: 一部の PDF が破損 / 暗号化されている場合があります。該当セッションだけ
  スキップされます (`data/slides/` には PDF が残るが `data/slides_text/` に対応する .txt が無い状態)。

---

## ステップ 3: AI 要約生成

```bash
node scripts/summarize.mjs                 # 全件
node scripts/summarize.mjs --dry-run       # 推定コストだけ表示
node scripts/summarize.mjs jpn-xxxNNN      # 指定 slug
node scripts/summarize.mjs --concurrency 8 # 並列度変更
node scripts/summarize.mjs --force         # 既存ファイルを上書き
```

**何が起きるか**:

1. `data/transcripts/{slug}.ja.txt` を Anthropic Messages API に投げる
2. `scripts/summarize-prompt.mjs` の架空サンプルをシステムプロンプトに含めてフォーマット誘導
3. 応答 JSON を `data/summaries/{slug}.json` に保存
4. 既存 `data/summaries/{slug}.json` はスキップ (レジューム)。`--force` で上書き

**所要**: 10-30 分 (並列度とレート制限による)
**推定コスト**: ~$5-15 USD (`claude-sonnet-4-6`, 133 セッション)
  - 正確な見積りは `--dry-run` で表示
**モデル**: `ANTHROPIC_MODEL` 環境変数で変更可 (例: `claude-opus-4-8`, `claude-haiku-4-5`)

**トラブル**:

- **429 / 5xx**: 自動的に指数バックオフ (1s → 2s → 4s → 8s + ジッタ) でリトライします
  (最大 4 回、`SUMMARIZE_MAX_RETRIES` で変更可)
- **JSON 解析失敗**: モデルが余計な文字を返した場合、最初の `{` から最後の `}` までを抽出します。
  それでも壊れていれば該当セッションはエラー扱いになり、再実行で続行できます。
- **citations が時系列順でない**: 警告のみ表示します。`scripts/sort-citations.mjs` で並び替え可能。

---

## ステップ 4: アプリ用検索インデックス構築

```bash
node app/scripts/build-index.mjs
```

**何が起きるか**:

1. `data/catalog.json` + `data/summaries/*.json` を `app/src/data/app-data.json` に集約
2. `data/slides_text/*.txt` を `app/src/data/slides-text.json` に集約

**所要**: 数秒
**サイズ**: ~5MB

---

## 追加: 一括検証

要約生成後にデータ整合性を確認したい場合:

```bash
node scripts/validate-summaries.mjs   # schema との突き合わせ
node scripts/audit-summaries.mjs      # citations 整合性チェック
node scripts/sort-citations.mjs       # startSec 昇順に並び替え
node scripts/finalize.mjs             # sort → validate → build-index を一括実行
```

---

## アプリ起動

```bash
cd app
npm install
npm run dev
# → http://localhost:5173 を開く
# → sidecar は http://localhost:3001 で起動 (concurrently で同時起動)
```

アプリ機能 / ページ構成は [ARCHITECTURE.md](ARCHITECTURE.md) を参照。
